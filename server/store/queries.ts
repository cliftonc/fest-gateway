/**
 * The read layer for the dashboard.
 *
 * ── Visibility is enforced HERE, and nowhere else ────────────────────────────
 *
 * Every exported function takes `Scope` as its first parameter after the store,
 * and every SQL statement in this file filters on `org_id`. There is no view,
 * no route middleware and no ORM layer that "also" checks tenancy — because the
 * moment there are two places a check can live, a future screen will be written
 * against the one that does not check, and it will leak another org's traffic.
 *
 * The same argument applies one level down: a `member` scope is constrained to
 * its own `user_id` by `scopeClause()` / `rollupSlice()`, once, rather than by
 * each query remembering to.
 *
 * ── The rollup cube, which WILL corrupt your numbers if you skim it ─────────
 *
 * `usage_hourly` is a CUBE, not a flat fact table. For every request the writer
 * (server/store/write.ts) upserts up to four keys:
 *
 *     (user, model)   the specific cell
 *     (user, '')      one developer, all models
 *     ('', model)     all developers, one model
 *     ('', '')        org totals
 *
 * de-duplicated, so an unattributed request or one with no resolved model
 * contributes exactly one increment rather than two or four.
 *
 * Two consequences, both easy to get wrong:
 *
 *  1. A "bucket" is NOT one row. The primary key also carries
 *     `credential_origin` and `cost_basis`, which are ALWAYS concrete — never
 *     `''`. So `('', '')` for one hour is one row per (origin, basis) pair
 *     actually observed. Every read must `SUM(...)` across them. A
 *     `SELECT ... WHERE user_id = '' AND served_model = '' LIMIT 1` would
 *     report a single origin's slice and look entirely plausible.
 *     `rollupSlice()` exists so no query invents its own pinning, and no query
 *     in this file ever pins `credential_origin` or `cost_basis`.
 *
 *  2. Summing across grains double-counts. An org total must pin
 *     `user_id = '' AND served_model = ''`; a per-user breakdown must pin
 *     `served_model = ''` and take `user_id <> ''`. Dropping either pin adds
 *     the same traffic in two or three times.
 *
 *  3. `''` is overloaded: on `user_id` it means both "all users" and
 *     "unattributed", and on `served_model` both "all models" and "never
 *     resolved". From the rollup alone those are indistinguishable. So the
 *     unattributed slice — which an admin genuinely needs to see, because it
 *     means someone is using Fest without an identity token — is recovered as a
 *     RESIDUAL: org total minus the sum of the attributed rows. That identity
 *     holds exactly because of the writer's de-duplication. On the raw path it
 *     comes straight from `user_id IS NULL`. Note the two tables use different
 *     representations deliberately (`NULL` in `requests`, `''` in the rollup,
 *     whose columns are NOT NULL and part of a primary key); both are handled
 *     and both surface as `userId: ''`.
 */

import type { UsagePayload, CostBasis } from "../../shared/types.ts";
import type { Cost } from "../usage/cost.ts";
import { cacheHitRatio } from "../usage/pricing.ts";
import type { Store } from "./db.ts";

// ── Scope ─────────────────────────────────────────────────────────────────────

export interface Scope {
  readonly orgId: string;
  /** Present for a member-scoped view; absent/undefined for admins. */
  readonly userId?: string | undefined;
  readonly role: "owner" | "admin" | "member";
}

export interface TimeRange {
  /** Inclusive. */
  readonly fromMs: number;
  /** Exclusive. */
  readonly toMs: number;
}

/** Everything `node:sqlite` will accept as a bound parameter here. */
type Param = string | number | null;

interface Clause {
  readonly sql: string;
  readonly params: Param[];
}

/**
 * The member's own `user_id`, or null for an org-wide scope.
 *
 * Fails closed: a `member` scope with no `userId` is a bug in the caller's
 * session handling, and answering it as though it were an admin would be the
 * exact leak this module exists to prevent.
 */
function memberUserId(scope: Scope): string | null {
  if (scope.role !== "member") return null;
  if (!scope.userId) {
    throw new Error("member scope requires a userId; refusing to widen to org-wide");
  }
  return scope.userId;
}

/**
 * The tenancy gate for raw `requests`.
 *
 * `alias` is the table alias so the fragment can be spliced into a join. For a
 * member we emit `user_id = ?`, which in SQL also excludes NULL rows — correct
 * and deliberate: an unattributed request is not provably the member's, and we
 * never guess who it was. An admin sees those rows; the member does not.
 */
function scopeClause(scope: Scope, alias: string): Clause {
  const params: Param[] = [scope.orgId];
  let sql = `${alias}.org_id = ?`;
  const uid = memberUserId(scope);
  if (uid !== null) {
    sql += ` AND ${alias}.user_id = ?`;
    params.push(uid);
  }
  return { sql, params };
}

/**
 * Which grain of the rollup cube a query wants. See the cube note at the top of
 * this file: choosing the wrong grain does not error, it double-counts.
 */
interface Grain {
  /** True when the query GROUPs BY user; false when it wants the user total. */
  readonly byUser: boolean;
  /** True when the query GROUPs BY model; false when it wants the model total. */
  readonly byModel: boolean;
}

/**
 * THE single place that pins the rollup cube's dimensions.
 *
 * Deliberately never mentions `credential_origin` or `cost_basis`: those are
 * always concrete in the cube, so a query must aggregate across them rather
 * than pin them. That is why this returns only a WHERE fragment and the callers
 * all use `SUM()`.
 */
function rollupSlice(scope: Scope, grain: Grain): Clause {
  const params: Param[] = [scope.orgId];
  let sql = "h.org_id = ?";

  const uid = memberUserId(scope);
  if (uid !== null) {
    // A member's own cell exists at both (uid, '') and (uid, model), so pinning
    // their id works at either grain.
    sql += " AND h.user_id = ?";
    params.push(uid);
  } else if (grain.byUser) {
    sql += " AND h.user_id <> ''";
  } else {
    sql += " AND h.user_id = ''";
  }

  if (grain.byModel) sql += " AND h.served_model <> ''";
  else sql += " AND h.served_model = ''";

  return { sql, params };
}

// ── Source selection ──────────────────────────────────────────────────────────

export type Source = "requests" | "usage_hourly";

/**
 * How recent a range has to be before we bypass the rollups and read raw rows.
 *
 * Two hours, because the hourly rollup lags BY DEFINITION: the current hour's
 * row is still accumulating, and the metering writer flushes in batches, so the
 * most recent bucket is always incomplete. A "last 30 minutes" panel served
 * from `usage_hourly` would under-report and look like an outage. Two hours
 * gives one complete hour plus the in-flight one, which is enough that any
 * range long enough to be a TREND reads the rollups instead — and those survive
 * raw-row retention deletion, which is the whole point of having them.
 */
export const RAW_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * ONE place decides raw-vs-rollup. Every screen calls this rather than picking
 * its own threshold, so two panels on the same page can never disagree about
 * where "today" came from.
 */
export function chooseSource(range: TimeRange): Source {
  return range.toMs - range.fromMs <= RAW_WINDOW_MS ? "requests" : "usage_hourly";
}

const HOUR_MS = 60 * 60 * 1000;

function hourFloor(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/**
 * Rollup ranges snap the lower edge outward to an hour boundary: an hourly
 * bucket is indivisible, so a range starting at 10:30 can only be answered with
 * the whole 10:00 bucket. Callers get slightly more than they asked for rather
 * than silently less — an over-count at the edge is visible, an under-count is
 * mistaken for a quiet period.
 */
function rollupRange(range: TimeRange): Clause {
  return {
    sql: "h.hour_start >= ? AND h.hour_start < ?",
    params: [hourFloor(range.fromMs), range.toMs],
  };
}

function rawRange(range: TimeRange): Clause {
  return { sql: "r.started_at >= ? AND r.started_at < ?", params: [range.fromMs, range.toMs] };
}

// ── Row coercion ──────────────────────────────────────────────────────────────
//
// `node:sqlite` hands back loosely-typed records, and INTEGER columns can arrive
// as number or bigint depending on magnitude. These helpers are the only place
// that deals with it, so no query body has a cast in it.

type Row = Record<string, unknown>;

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v ?? 0);
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return num(v);
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : v === null || v === undefined ? null : String(v);
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : v === null || v === undefined ? fallback : String(v);
}

/**
 * "Is an error" — ONE definition, and it is the writer's.
 *
 * `server/store/write.ts` increments `usage_hourly.errors` when
 * `status !== 'ok'`, so the raw path must use the same predicate or the same
 * range would report different error counts depending on which side of the
 * 2-hour threshold it fell. In particular this includes `identity_denied`
 * (a rejected request, recorded on purpose so an admin can see auth failures)
 * and `client_abort`, neither of which necessarily carries an `error_type`.
 *
 * NOTE: this means the `requests_errors` partial index — predicated on
 * `error_type IS NOT NULL` — does not cover this predicate. Matching the
 * numbers matters more than matching the index; see the report accompanying
 * this module.
 */
const RAW_IS_ERROR = "r.status <> 'ok'";

// ── Feed ──────────────────────────────────────────────────────────────────────

export interface RequestRow {
  /** Monotonic rowid. Doubles as the keyset pagination cursor. */
  readonly seq: number;
  readonly id: string;
  readonly startedAt: number;
  /** Null for an unattributed request: recorded, never dropped, never guessed. */
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly requestedModel: string | null;
  readonly servedModel: string | null;
  readonly posture: string;
  readonly credentialOrigin: string;
  readonly credentialFingerprint: string | null;
  readonly status: string;
  readonly httpStatus: number | null;
  readonly errorType: string | null;
  readonly stream: boolean;
  readonly partial: boolean;
  readonly usage: UsagePayload;
  /** Null means "no dollar figure applies or is available". Never zero. */
  readonly costUsd: Cost;
  readonly costBasis: CostBasis;
  readonly ttfbMs: number | null;
  readonly durationMs: number;
  readonly rl5hUtilization: number | null;
  readonly rlClaim: string | null;
  readonly clientVersion: string | null;
}

export interface FeedFilter {
  readonly userId?: string | undefined;
  readonly servedModel?: string | undefined;
  readonly credentialOrigin?: string | undefined;
  readonly errorsOnly?: boolean | undefined;
  readonly sessionId?: string | undefined;
  /** Keyset cursor: return rows with seq < beforeSeq. */
  readonly beforeSeq?: number | undefined;
  readonly limit?: number | undefined;
}

const DEFAULT_LIMIT = 50;
/** A page bigger than this is a mistake or an attempt to dump the table. */
export const MAX_LIMIT = 500;

/**
 * `limit` arrives from a query string, so treat it as hostile: coerce to an
 * integer and clamp. Not doing this is how `LIMIT ?` becomes a table export.
 */
function clampLimit(limit: number | undefined): number {
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Sentinel for "no cursor yet". Binding a cursor on EVERY call keeps the feed a
 * single SQL shape, which matters for the plan: with `seq < ?` present SQLite
 * drives the query off a bounded descending rowid search, whereas the
 * cursor-less variant falls back to a temp b-tree sort of the whole org.
 */
const SEQ_SENTINEL = Number.MAX_SAFE_INTEGER;

function clampCursor(beforeSeq: number | undefined): number {
  const n = Math.trunc(Number(beforeSeq));
  if (!Number.isFinite(n) || n <= 0) return SEQ_SENTINEL;
  return Math.min(n, SEQ_SENTINEL);
}

const FEED_COLUMNS = `
  r.seq, r.id, r.started_at, r.user_id, r.session_id,
  r.requested_model, r.served_model, r.posture, r.credential_origin,
  r.credential_fingerprint, r.status, r.http_status, r.error_type,
  r.stream, r.partial,
  r.input_tokens, r.cache_read_tokens, r.cache_write_5m_tokens,
  r.cache_write_1h_tokens, r.output_tokens, r.web_searches, r.service_tier,
  r.cost_usd, r.cost_basis, r.ttfb_ms, r.duration_ms,
  r.rl_5h_utilization, r.rl_claim, r.client_version`;

/**
 * Build the feed SQL and params. Exported so the query-plan test can assert on
 * the exact statement the app runs, rather than on a hand-written approximation
 * of it that would quietly drift.
 */
export function feedSql(scope: Scope, filter: FeedFilter): { sql: string; params: Param[] } {
  const scoped = scopeClause(scope, "r");
  const params: Param[] = [...scoped.params];
  let where = scoped.sql;

  // Filters are appended as `AND col = ?` with a parallel params array. No
  // value is ever interpolated into the string — not even one that "looks like"
  // an enum, because `credentialOrigin` and `servedModel` both come straight
  // off a query string.
  if (filter.userId !== undefined) {
    where += " AND r.user_id = ?";
    params.push(filter.userId);
  }
  if (filter.servedModel !== undefined) {
    where += " AND r.served_model = ?";
    params.push(filter.servedModel);
  }
  if (filter.credentialOrigin !== undefined) {
    where += " AND r.credential_origin = ?";
    params.push(filter.credentialOrigin);
  }
  if (filter.sessionId !== undefined) {
    where += " AND r.session_id = ?";
    params.push(filter.sessionId);
  }
  if (filter.errorsOnly) where += ` AND ${RAW_IS_ERROR}`;

  params.push(clampCursor(filter.beforeSeq));
  params.push(clampLimit(filter.limit));

  const sql = `SELECT ${FEED_COLUMNS}
    FROM requests r
    WHERE ${where} AND r.seq < ?
    ORDER BY r.seq DESC
    LIMIT ?`;
  return { sql, params };
}

function toRequestRow(row: Row): RequestRow {
  return {
    seq: num(row["seq"]),
    id: str(row["id"]),
    startedAt: num(row["started_at"]),
    userId: strOrNull(row["user_id"]),
    sessionId: strOrNull(row["session_id"]),
    requestedModel: strOrNull(row["requested_model"]),
    servedModel: strOrNull(row["served_model"]),
    posture: str(row["posture"]),
    credentialOrigin: str(row["credential_origin"]),
    credentialFingerprint: strOrNull(row["credential_fingerprint"]),
    status: str(row["status"]),
    httpStatus: numOrNull(row["http_status"]),
    errorType: strOrNull(row["error_type"]),
    stream: num(row["stream"]) !== 0,
    partial: num(row["partial"]) !== 0,
    usage: {
      inputTokens: num(row["input_tokens"]),
      cacheReadTokens: num(row["cache_read_tokens"]),
      cacheWrite5mTokens: num(row["cache_write_5m_tokens"]),
      cacheWrite1hTokens: num(row["cache_write_1h_tokens"]),
      outputTokens: num(row["output_tokens"]),
      webSearches: num(row["web_searches"]),
      serviceTier: strOrNull(row["service_tier"]) ?? undefined,
    },
    costUsd: numOrNull(row["cost_usd"]),
    costBasis: str(row["cost_basis"], "none") as CostBasis,
    ttfbMs: numOrNull(row["ttfb_ms"]),
    durationMs: num(row["duration_ms"]),
    rl5hUtilization: numOrNull(row["rl_5h_utilization"]),
    rlClaim: strOrNull(row["rl_claim"]),
    clientVersion: strOrNull(row["client_version"]),
  };
}

/**
 * Newest-first page of requests, keyset paginated on `seq`.
 *
 * Keyset and not OFFSET: the feed is append-heavy, so between page 1 and page 2
 * new rows arrive at the top and every OFFSET page shifts underneath the
 * reader — they see one row twice and miss another entirely. `seq < cursor` is
 * stable under concurrent inserts, and costs the same at page 1 and page 900.
 */
export function listRequests(
  store: Store,
  scope: Scope,
  filter: FeedFilter,
): { rows: RequestRow[]; nextCursor: number | null } {
  const limit = clampLimit(filter.limit);
  const { sql, params } = feedSql(scope, filter);
  const rows = (store.db.prepare(sql).all(...params) as Row[]).map(toRequestRow);
  // A short page means we reached the end; only a full page can have more
  // behind it. Handing back a cursor on a short page would make the UI issue a
  // guaranteed-empty request at the bottom of every feed.
  const last = rows[rows.length - 1];
  const nextCursor = rows.length === limit && last !== undefined ? last.seq : null;
  return { rows, nextCursor };
}

// ── Totals ────────────────────────────────────────────────────────────────────

export interface UsageTotals {
  readonly requests: number;
  readonly errors: number;
  readonly usage: UsagePayload;
  /**
   * Sum of the PRICED rows only. Meaningless on its own — always render it with
   * the two counts below.
   */
  readonly pricedCostUsd: number;
  /** Rows we could not price. Non-zero means `pricedCostUsd` is a lower bound. */
  readonly unpricedRequests: number;
  /** Rows the developer's own subscription absorbed: real usage, no org spend. */
  readonly subscriptionRequests: number;
  readonly cacheHitRatio: number | null;
}

/**
 * Aggregate expressions, raw-rows flavour.
 *
 * Cost honesty, which is the whole reason this is three columns and not one:
 *
 *  - SQL `SUM()` SKIPS NULLs. A bare `SUM(cost_usd)` therefore returns a total
 *    that quietly omits every row we could not price, and looks completely
 *    plausible while being short. `unpriced_requests` is the receipt.
 *  - A `subscription` row is REAL USAGE WITH NO ORG SPEND. It is not $0 — $0
 *    would say "this was free", and any average or forecast over it would be
 *    wrong. It must never be added into a dollar total, so it is excluded from
 *    the sum (`CASE ... THEN NULL`, defensive in case a notional price is ever
 *    written into the column) and counted separately instead.
 *
 * With all three a caller can render "$12.3456 (+3 n/a)" — see `formatCostSum`
 * in server/usage/cost.ts, which is the intended consumer.
 */
const RAW_AGG = `
  COUNT(*) AS requests,
  COALESCE(SUM(CASE WHEN ${RAW_IS_ERROR} THEN 1 ELSE 0 END), 0) AS errors,
  COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
  COALESCE(SUM(r.cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(r.cache_write_5m_tokens), 0) AS cache_write_5m_tokens,
  COALESCE(SUM(r.cache_write_1h_tokens), 0) AS cache_write_1h_tokens,
  COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(r.web_searches), 0) AS web_searches,
  COALESCE(SUM(CASE WHEN r.cost_basis = 'subscription' THEN NULL ELSE r.cost_usd END), 0)
    AS priced_cost_usd,
  COALESCE(SUM(CASE WHEN r.cost_usd IS NULL AND r.cost_basis <> 'subscription'
                    THEN 1 ELSE 0 END), 0) AS unpriced_requests,
  COALESCE(SUM(CASE WHEN r.cost_basis = 'subscription' THEN 1 ELSE 0 END), 0)
    AS subscription_requests`;

/**
 * The same three cost figures, rollup flavour. `usage_hourly.cost_usd` is
 * already a priced-only sum and carries its own two counts, precisely so the
 * honesty survives the raw rows being deleted by retention.
 */
const ROLLUP_AGG = `
  COALESCE(SUM(h.requests), 0) AS requests,
  COALESCE(SUM(h.errors), 0) AS errors,
  COALESCE(SUM(h.input_tokens), 0) AS input_tokens,
  COALESCE(SUM(h.cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(h.cache_write_5m_tokens), 0) AS cache_write_5m_tokens,
  COALESCE(SUM(h.cache_write_1h_tokens), 0) AS cache_write_1h_tokens,
  COALESCE(SUM(h.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(h.web_searches), 0) AS web_searches,
  COALESCE(SUM(h.cost_usd), 0) AS priced_cost_usd,
  COALESCE(SUM(h.unpriced_requests), 0) AS unpriced_requests,
  COALESCE(SUM(h.subscription_requests), 0) AS subscription_requests`;

function makeTotals(
  parts: {
    requests: number;
    errors: number;
    usage: UsagePayload;
    pricedCostUsd: number;
    unpricedRequests: number;
    subscriptionRequests: number;
  },
): UsageTotals {
  return {
    ...parts,
    // Single definition of cache hit ratio, in server/usage/pricing.ts. Do not
    // re-derive it here: the denominator is the four disjoint context buckets,
    // and getting that wrong is the classic order-of-magnitude double-count.
    cacheHitRatio: cacheHitRatio(parts.usage),
  };
}

function toTotals(row: Row): UsageTotals {
  return makeTotals({
    requests: num(row["requests"]),
    errors: num(row["errors"]),
    usage: {
      inputTokens: num(row["input_tokens"]),
      cacheReadTokens: num(row["cache_read_tokens"]),
      cacheWrite5mTokens: num(row["cache_write_5m_tokens"]),
      cacheWrite1hTokens: num(row["cache_write_1h_tokens"]),
      outputTokens: num(row["output_tokens"]),
      webSearches: num(row["web_searches"]),
    },
    pricedCostUsd: num(row["priced_cost_usd"]),
    unpricedRequests: num(row["unpriced_requests"]),
    subscriptionRequests: num(row["subscription_requests"]),
  });
}

const EMPTY_ROW: Row = {};

/**
 * Org total minus the attributed rows: the unattributed residual.
 *
 * Only meaningful on the rollup path, and only because the writer de-duplicates
 * its key set, so the `('', '')` cell is exactly the whole org. See the cube
 * note at the top of the file.
 */
function subtractTotals(total: UsageTotals, parts: readonly UsageTotals[]): UsageTotals {
  const acc = {
    requests: total.requests,
    errors: total.errors,
    inputTokens: total.usage.inputTokens,
    cacheReadTokens: total.usage.cacheReadTokens,
    cacheWrite5mTokens: total.usage.cacheWrite5mTokens,
    cacheWrite1hTokens: total.usage.cacheWrite1hTokens,
    outputTokens: total.usage.outputTokens,
    webSearches: total.usage.webSearches,
    pricedCostUsd: total.pricedCostUsd,
    unpricedRequests: total.unpricedRequests,
    subscriptionRequests: total.subscriptionRequests,
  };
  for (const p of parts) {
    acc.requests -= p.requests;
    acc.errors -= p.errors;
    acc.inputTokens -= p.usage.inputTokens;
    acc.cacheReadTokens -= p.usage.cacheReadTokens;
    acc.cacheWrite5mTokens -= p.usage.cacheWrite5mTokens;
    acc.cacheWrite1hTokens -= p.usage.cacheWrite1hTokens;
    acc.outputTokens -= p.usage.outputTokens;
    acc.webSearches -= p.usage.webSearches;
    acc.pricedCostUsd -= p.pricedCostUsd;
    acc.unpricedRequests -= p.unpricedRequests;
    acc.subscriptionRequests -= p.subscriptionRequests;
  }
  return makeTotals({
    requests: acc.requests,
    errors: acc.errors,
    usage: {
      inputTokens: acc.inputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheWrite5mTokens: acc.cacheWrite5mTokens,
      cacheWrite1hTokens: acc.cacheWrite1hTokens,
      outputTokens: acc.outputTokens,
      webSearches: acc.webSearches,
    },
    // Floating-point subtraction of REAL sums can leave a -1e-17 here. Clamp,
    // because a dashboard rendering "-$0.0000" destroys trust in every other
    // number on the page.
    pricedCostUsd: Math.max(acc.pricedCostUsd, 0),
    unpricedRequests: acc.unpricedRequests,
    subscriptionRequests: acc.subscriptionRequests,
  });
}

interface AggOpts {
  readonly rawSelect?: string;
  readonly rollupSelect?: string;
  readonly rawJoin?: string;
  readonly rollupJoin?: string;
  readonly rawGroupBy?: string;
  readonly rollupGroupBy?: string;
  readonly orderBy?: string;
}

/**
 * Build an aggregate query over whichever source `chooseSource` picked, at the
 * requested cube grain. Shared so a fix to the cost arithmetic lands in every
 * panel at once instead of five out of six.
 */
function aggregateQuery(
  scope: Scope,
  range: TimeRange,
  grain: Grain,
  opts: AggOpts = {},
): { sql: string; params: Param[] } {
  if (chooseSource(range) === "requests") {
    const scoped = scopeClause(scope, "r");
    const time = rawRange(range);
    const select = opts.rawSelect ? `${opts.rawSelect}, ${RAW_AGG}` : RAW_AGG;
    return {
      sql: `SELECT ${select}
        FROM requests r${opts.rawJoin ?? ""}
        WHERE ${scoped.sql} AND ${time.sql}
        ${opts.rawGroupBy ? `GROUP BY ${opts.rawGroupBy}` : ""}
        ${opts.orderBy ? `ORDER BY ${opts.orderBy}` : ""}`,
      params: [...scoped.params, ...time.params],
    };
  }
  const slice = rollupSlice(scope, grain);
  const time = rollupRange(range);
  const select = opts.rollupSelect ? `${opts.rollupSelect}, ${ROLLUP_AGG}` : ROLLUP_AGG;
  return {
    sql: `SELECT ${select}
      FROM usage_hourly h${opts.rollupJoin ?? ""}
      WHERE ${slice.sql} AND ${time.sql}
      ${opts.rollupGroupBy ? `GROUP BY ${opts.rollupGroupBy}` : ""}
      ${opts.orderBy ? `ORDER BY ${opts.orderBy}` : ""}`,
    params: [...slice.params, ...time.params],
  };
}

function runTotals(store: Store, q: { sql: string; params: Param[] }): UsageTotals {
  const row = store.db.prepare(q.sql).get(...q.params) as Row | undefined;
  return toTotals(row ?? EMPTY_ROW);
}

const ORG_GRAIN: Grain = { byUser: false, byModel: false };

export function usageTotals(store: Store, scope: Scope, range: TimeRange): UsageTotals {
  return runTotals(store, aggregateQuery(scope, range, ORG_GRAIN));
}

/**
 * Per-user totals.
 *
 * LEFT JOIN, not JOIN, and it has to stay that way: `requests.user_id` is
 * nullable because a call with no identity token is recorded as unattributed
 * rather than dropped. An inner join would hide those rows, and unattributed
 * usage is precisely what an admin needs to SEE — it means a developer is
 * pointing Claude Code at Fest without an identity token, so their spend is
 * landing in nobody's column.
 *
 * Unattributed usage surfaces as `userId: ''` with `email: null`: directly from
 * `user_id IS NULL` on the raw path, and as the org-total-minus-attributed
 * residual on the rollup path, where `''` cannot be told apart from "all".
 */
export function usageByUser(
  store: Store,
  scope: Scope,
  range: TimeRange,
): Array<{ userId: string; email: string | null } & UsageTotals> {
  const q = usageByUserSql(scope, range);
  const rows = (store.db.prepare(q.sql).all(...q.params) as Row[]).map((row) => ({
    userId: str(row["user_id"]),
    email: strOrNull(row["email"]),
    ...toTotals(row),
  }));

  if (chooseSource(range) === "requests") return rows;

  // Rollup path: recover the unattributed slice as a residual.
  const total = usageTotals(store, scope, range);
  const residual = subtractTotals(total, rows);
  if (residual.requests > 0) rows.push({ userId: "", email: null, ...residual });
  return rows;
}

/** Exported for the query-plan test; see `feedSql`. */
export function usageByUserSql(scope: Scope, range: TimeRange): { sql: string; params: Param[] } {
  return aggregateQuery(
    scope,
    range,
    { byUser: true, byModel: false },
    {
      rawSelect: "COALESCE(r.user_id, '') AS user_id, MAX(u.email) AS email",
      rollupSelect: "h.user_id AS user_id, MAX(u.email) AS email",
      // The join is scoped by org too. User ids are prefixed uuids so a
      // cross-org collision is not realistic, but a join that can only ever
      // match inside the tenant is one less thing to have to reason about.
      rawJoin: " LEFT JOIN users u ON u.id = r.user_id AND u.org_id = r.org_id",
      rollupJoin: " LEFT JOIN users u ON u.id = h.user_id AND u.org_id = h.org_id",
      rawGroupBy: "COALESCE(r.user_id, '')",
      rollupGroupBy: "h.user_id",
      orderBy: "requests DESC",
    },
  );
}

/**
 * Per-model totals. A request that errored before a model was resolved has no
 * `served_model`; it surfaces as `servedModel: ''` rather than being dropped,
 * by the same residual trick as `usageByUser`.
 */
export function usageByModel(
  store: Store,
  scope: Scope,
  range: TimeRange,
): Array<{ servedModel: string } & UsageTotals> {
  const q = aggregateQuery(
    scope,
    range,
    { byUser: false, byModel: true },
    {
      rawSelect: "COALESCE(r.served_model, '') AS served_model",
      rollupSelect: "h.served_model AS served_model",
      rawGroupBy: "COALESCE(r.served_model, '')",
      rollupGroupBy: "h.served_model",
      orderBy: "requests DESC",
    },
  );
  const rows = (store.db.prepare(q.sql).all(...q.params) as Row[]).map((row) => ({
    servedModel: str(row["served_model"]),
    ...toTotals(row),
  }));

  if (chooseSource(range) === "requests") return rows;

  const residual = subtractTotals(usageTotals(store, scope, range), rows);
  if (residual.requests > 0) rows.push({ servedModel: "", ...residual });
  return rows;
}

/**
 * Per-credential-origin totals. This is the compliance view: it answers "how
 * much of our traffic ran on a server-held key" at a glance, and
 * `distinctUsers` answers "how many people did that affect".
 *
 * `credential_origin` is never `''` in the cube, so the org grain already
 * carries every origin and no residual is needed. `distinctUsers` does need a
 * second, per-user-grain query though: a count of distinct users cannot be
 * recovered from rows where the user dimension is collapsed to `''`.
 */
export function usageByCredentialOrigin(
  store: Store,
  scope: Scope,
  range: TimeRange,
): Array<{ credentialOrigin: string; distinctUsers: number } & UsageTotals> {
  const raw = chooseSource(range) === "requests";
  const q = aggregateQuery(scope, range, ORG_GRAIN, {
    rawSelect:
      "r.credential_origin AS credential_origin, COUNT(DISTINCT r.user_id) AS distinct_users",
    rollupSelect: "h.credential_origin AS credential_origin",
    rawGroupBy: "r.credential_origin",
    rollupGroupBy: "h.credential_origin",
    orderBy: "requests DESC",
  });
  const rows = (store.db.prepare(q.sql).all(...q.params) as Row[]).map((row) => ({
    credentialOrigin: str(row["credential_origin"]),
    // COUNT(DISTINCT user_id) ignores NULLs, so an unattributed request is not
    // counted as a person. It is visible in `usageByUser` instead.
    distinctUsers: num(row["distinct_users"]),
    ...toTotals(row),
  }));
  if (raw) return rows;

  const slice = rollupSlice(scope, { byUser: true, byModel: false });
  const time = rollupRange(range);
  const counts = new Map<string, number>();
  const countRows = store.db
    .prepare(
      `SELECT h.credential_origin AS credential_origin,
              COUNT(DISTINCT h.user_id) AS distinct_users
       FROM usage_hourly h WHERE ${slice.sql} AND ${time.sql}
       GROUP BY h.credential_origin`,
    )
    .all(...slice.params, ...time.params) as Row[];
  for (const row of countRows) counts.set(str(row["credential_origin"]), num(row["distinct_users"]));
  return rows.map((row) => ({ ...row, distinctUsers: counts.get(row.credentialOrigin) ?? 0 }));
}

/**
 * Hourly series for a sparkline. Gaps are gaps: an hour with no traffic is
 * absent rather than zero-filled, because the caller knows the range it asked
 * for, whereas this layer cannot tell "no traffic" from "outside retention".
 */
export function usageSeries(
  store: Store,
  scope: Scope,
  range: TimeRange,
): Array<{ hourStart: number } & UsageTotals> {
  const q = aggregateQuery(scope, range, ORG_GRAIN, {
    // Integer division truncates in SQLite, which is exactly the bucketing we
    // want, and it keeps the arithmetic in epoch ms with no timezone anywhere.
    rawSelect: `(r.started_at / ${HOUR_MS}) * ${HOUR_MS} AS hour_start`,
    rollupSelect: "h.hour_start AS hour_start",
    rawGroupBy: `r.started_at / ${HOUR_MS}`,
    rollupGroupBy: "h.hour_start",
    orderBy: "hour_start ASC",
  });
  return (store.db.prepare(q.sql).all(...q.params) as Row[]).map((row) => ({
    hourStart: num(row["hour_start"]),
    ...toTotals(row),
  }));
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Error breakdown.
 *
 * Always reads raw `requests`, regardless of range: the rollup keeps an error
 * COUNT but not `error_type`/`http_status`, so there is nothing to group by
 * there. That means this view goes blank once retention has deleted the raw
 * rows for a range, which is honest — a breakdown we cannot compute must not be
 * approximated.
 *
 * `errorType` is genuinely nullable: a `client_abort` or an `identity_denied`
 * rejection is a non-ok status that may carry no error type at all, and those
 * are exactly the rows an admin wants to see (an identity_denied run means
 * someone's token is wrong).
 */
export function errorBreakdown(
  store: Store,
  scope: Scope,
  range: TimeRange,
): Array<{ errorType: string | null; httpStatus: number | null; count: number }> {
  const scoped = scopeClause(scope, "r");
  const time = rawRange(range);
  const sql = `SELECT r.error_type AS error_type, r.http_status AS http_status, COUNT(*) AS count
    FROM requests r
    WHERE ${scoped.sql} AND ${time.sql} AND ${RAW_IS_ERROR}
    GROUP BY r.error_type, r.http_status
    ORDER BY count DESC, r.error_type ASC`;
  return (store.db.prepare(sql).all(...scoped.params, ...time.params) as Row[]).map((row) => ({
    errorType: strOrNull(row["error_type"]),
    httpStatus: numOrNull(row["http_status"]),
    count: num(row["count"]),
  }));
}

// ── Latency ───────────────────────────────────────────────────────────────────

/**
 * Lower and upper edges of the fixed histogram buckets from `usage_hourly`:
 * <1s, <3s, <10s, <30s, <60s, >=60s. Must stay in step with `latencyBucket` in
 * server/store/write.ts — the writer decides which bucket a row lands in, this
 * decides what that bucket means.
 *
 * The last bucket is open-ended on purpose: a gateway relaying agent turns has
 * a genuinely unbounded tail, and inventing an upper edge for it would invent a
 * percentile.
 */
const LAT_LOWER = [0, 1000, 3000, 10_000, 30_000, 60_000] as const;
const LAT_UPPER = [1000, 3000, 10_000, 30_000, 60_000, null] as const;
export const LAT_BUCKET_COUNT = LAT_LOWER.length;

export interface LatencySummary {
  readonly count: number;
  readonly avgDurationMs: number | null;
  readonly maxDurationMs: number | null;
  readonly avgTtfbMs: number | null;
  /**
   * EXACT (nearest-rank) on the raw path; an INTERPOLATION from histogram
   * buckets on the rollup path. Never label the bucketed figure as exact in a
   * UI — see `interpolatePercentile`.
   */
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly buckets: readonly number[];
}

/**
 * Linear interpolation of a percentile within the fixed buckets.
 *
 * Why buckets exist at all: PERCENTILES DO NOT MERGE ACROSS ROLLUP ROWS. You
 * cannot average two hours' p95s, or take the larger, and get the p95 of the
 * two hours combined — the information needed to do that was thrown away when
 * each hour was summarised. Bucket COUNTS, by contrast, simply add. So the
 * rollup stores counts and we reconstruct a percentile from them.
 *
 * The reconstruction assumes latency is uniformly distributed inside each
 * bucket, which it is not. The result is therefore an ESTIMATE with a
 * resolution no finer than the bucket it lands in: a p95 reported as 24.5s
 * really means "somewhere in 10s–30s". Present it as approximate. If you need
 * an exact p95, shorten the range until `chooseSource` reads raw rows.
 *
 * A percentile landing in the open-ended top bucket returns that bucket's lower
 * edge (60s) as a FLOOR, because there is no upper edge to interpolate toward.
 */
export function interpolatePercentile(buckets: readonly number[], p: number): number | null {
  let total = 0;
  for (const b of buckets) total += b;
  if (total <= 0) return null;

  const target = p * total;
  let cumulative = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    const inBucket = buckets[i] ?? 0;
    if (inBucket === 0) continue;
    if (cumulative + inBucket >= target) {
      const lower = LAT_LOWER[i] ?? 0;
      const upper = LAT_UPPER[i];
      if (upper === null || upper === undefined) return lower;
      const fraction = (target - cumulative) / inBucket;
      return lower + fraction * (upper - lower);
    }
    cumulative += inBucket;
  }
  // Unreachable while total > 0; returning the top edge still beats returning
  // null, which a caller would read as "no data".
  return LAT_LOWER[LAT_LOWER.length - 1] ?? null;
}

/** Nearest-rank percentile over a sorted array. No interpolation, no estimate. */
function exactPercentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(p * sorted.length) - 1;
  const idx = Math.min(Math.max(rank, 0), sorted.length - 1);
  return sorted[idx] ?? null;
}

/** Bucket a raw duration. Mirrors `latencyBucket` in write.ts. */
function bucketOf(durationMs: number): number {
  for (let b = 0; b < LAT_BUCKET_COUNT; b += 1) {
    const upper = LAT_UPPER[b];
    if (upper === null || upper === undefined || durationMs < upper) return b;
  }
  return LAT_BUCKET_COUNT - 1;
}

export function latencySummary(store: Store, scope: Scope, range: TimeRange): LatencySummary {
  if (chooseSource(range) === "requests") {
    const scoped = scopeClause(scope, "r");
    const time = rawRange(range);
    const params = [...scoped.params, ...time.params];
    // Pulling the durations out and sorting in JS is acceptable here *because*
    // this branch only ever runs for a range of <= RAW_WINDOW_MS. Do not reuse
    // it for a long range: that is what the bucketed branch below is for.
    const durations = (
      store.db
        .prepare(
          `SELECT r.duration_ms AS duration_ms FROM requests r
           WHERE ${scoped.sql} AND ${time.sql} ORDER BY r.duration_ms ASC`,
        )
        .all(...params) as Row[]
    ).map((row) => num(row["duration_ms"]));

    const agg = store.db
      .prepare(
        `SELECT COUNT(*) AS count, AVG(r.duration_ms) AS avg_duration,
                MAX(r.duration_ms) AS max_duration, AVG(r.ttfb_ms) AS avg_ttfb
         FROM requests r WHERE ${scoped.sql} AND ${time.sql}`,
      )
      .get(...params) as Row | undefined;

    const buckets = new Array<number>(LAT_BUCKET_COUNT).fill(0);
    for (const d of durations) {
      const i = bucketOf(d);
      buckets[i] = (buckets[i] ?? 0) + 1;
    }

    return {
      count: num(agg?.["count"]),
      avgDurationMs: numOrNull(agg?.["avg_duration"]),
      maxDurationMs: numOrNull(agg?.["max_duration"]),
      // AVG ignores NULLs, so this is already an average over requests that
      // actually produced a first byte rather than one diluted by aborts.
      avgTtfbMs: numOrNull(agg?.["avg_ttfb"]),
      p50Ms: exactPercentile(durations, 0.5),
      p95Ms: exactPercentile(durations, 0.95),
      buckets,
    };
  }

  // Org grain: summing per-user or per-model cells as well would count every
  // request two to four times over. See the cube note at the top of the file.
  const slice = rollupSlice(scope, ORG_GRAIN);
  const time = rollupRange(range);
  const row = store.db
    .prepare(
      `SELECT COALESCE(SUM(h.requests), 0) AS count,
              COALESCE(SUM(h.duration_ms_sum), 0) AS duration_sum,
              MAX(h.duration_ms_max) AS max_duration,
              COALESCE(SUM(h.ttfb_ms_sum), 0) AS ttfb_sum,
              COALESCE(SUM(h.ttfb_count), 0) AS ttfb_count,
              COALESCE(SUM(h.lat_b0), 0) AS b0, COALESCE(SUM(h.lat_b1), 0) AS b1,
              COALESCE(SUM(h.lat_b2), 0) AS b2, COALESCE(SUM(h.lat_b3), 0) AS b3,
              COALESCE(SUM(h.lat_b4), 0) AS b4, COALESCE(SUM(h.lat_b5), 0) AS b5
       FROM usage_hourly h WHERE ${slice.sql} AND ${time.sql}`,
    )
    .get(...slice.params, ...time.params) as Row | undefined;

  const r = row ?? EMPTY_ROW;
  const count = num(r["count"]);
  const ttfbCount = num(r["ttfb_count"]);
  const buckets = [
    num(r["b0"]),
    num(r["b1"]),
    num(r["b2"]),
    num(r["b3"]),
    num(r["b4"]),
    num(r["b5"]),
  ];

  return {
    count,
    avgDurationMs: count > 0 ? num(r["duration_sum"]) / count : null,
    maxDurationMs: numOrNull(r["max_duration"]),
    // Divided by ttfb_count, not requests: a non-streaming or failed call has
    // no TTFB, and dividing by the request count would silently deflate it.
    avgTtfbMs: ttfbCount > 0 ? num(r["ttfb_sum"]) / ttfbCount : null,
    p50Ms: interpolatePercentile(buckets, 0.5),
    p95Ms: interpolatePercentile(buckets, 0.95),
    buckets,
  };
}

// ── Quota ─────────────────────────────────────────────────────────────────────

export interface QuotaSnapshot {
  readonly userId: string | null;
  readonly email: string | null;
  readonly observedAt: number;
  readonly fiveHourUtilization: number | null;
  readonly fiveHourStatus: string | null;
  readonly fiveHourResetAt: number | null;
  readonly sevenDayUtilization: number | null;
  readonly sevenDayStatus: string | null;
  readonly sevenDayResetAt: number | null;
  readonly claim: string | null;
  readonly overageStatus: string | null;
  readonly overageReason: string | null;
}

/**
 * Latest observed quota snapshot per user.
 *
 * For a developer on a subscription THIS — not dollars — is the scarce
 * resource, so it gets its own panel. There is no time range: the question is
 * always "where does everyone stand right now", and the answer is whatever the
 * most recent request that actually CARRIED quota headers reported. Quota lives
 * only on raw rows, so this view is bounded by raw-row retention.
 *
 * Requests with no quota headers are skipped rather than surfaced as nulls. A
 * failed or aborted call has no headers, and letting one overwrite a real
 * snapshot with blanks would make the panel flicker to "unknown" exactly when a
 * developer is hitting limits — the moment it matters most.
 *
 * Ties on `started_at` (same millisecond) break on `seq`, so the result is
 * deterministic rather than whatever the planner happened to emit last.
 */
export function latestQuotaByUser(store: Store, scope: Scope): QuotaSnapshot[] {
  const scoped = scopeClause(scope, "r");
  const sql = `SELECT q.user_id AS user_id, u.email AS email, q.started_at AS observed_at,
      q.rl_5h_utilization, q.rl_5h_status, q.rl_5h_reset_at,
      q.rl_7d_utilization, q.rl_7d_status, q.rl_7d_reset_at,
      q.rl_claim, q.rl_overage_status, q.rl_overage_reason
    FROM (
      SELECT r.user_id, r.org_id, r.started_at, r.seq,
             r.rl_5h_utilization, r.rl_5h_status, r.rl_5h_reset_at,
             r.rl_7d_utilization, r.rl_7d_status, r.rl_7d_reset_at,
             r.rl_claim, r.rl_overage_status, r.rl_overage_reason,
             ROW_NUMBER() OVER (
               PARTITION BY COALESCE(r.user_id, '')
               ORDER BY r.started_at DESC, r.seq DESC
             ) AS rn
      FROM requests r
      WHERE ${scoped.sql}
        AND (r.rl_status IS NOT NULL
             OR r.rl_5h_utilization IS NOT NULL
             OR r.rl_7d_utilization IS NOT NULL
             OR r.rl_claim IS NOT NULL)
    ) q
    LEFT JOIN users u ON u.id = q.user_id AND u.org_id = q.org_id
    WHERE q.rn = 1
    ORDER BY q.observed_at DESC`;
  return (store.db.prepare(sql).all(...scoped.params) as Row[]).map((row) => ({
    userId: strOrNull(row["user_id"]),
    email: strOrNull(row["email"]),
    observedAt: num(row["observed_at"]),
    fiveHourUtilization: numOrNull(row["rl_5h_utilization"]),
    fiveHourStatus: strOrNull(row["rl_5h_status"]),
    fiveHourResetAt: numOrNull(row["rl_5h_reset_at"]),
    sevenDayUtilization: numOrNull(row["rl_7d_utilization"]),
    sevenDayStatus: strOrNull(row["rl_7d_status"]),
    sevenDayResetAt: numOrNull(row["rl_7d_reset_at"]),
    claim: strOrNull(row["rl_claim"]),
    overageStatus: strOrNull(row["rl_overage_status"]),
    overageReason: strOrNull(row["rl_overage_reason"]),
  }));
}
