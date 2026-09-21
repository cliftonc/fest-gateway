/**
 * The read layer for the dashboard.
 *
 * ── Visibility is enforced HERE, and nowhere else ────────────────────────────
 *
 * Every exported function takes `Scope` as its first parameter, and every SQL
 * statement in this file filters on `org_id`. There is no view, no route
 * middleware and no ORM layer that "also" checks tenancy — because the moment
 * there are two places a check can live, a future screen will be written
 * against the one that does not check, and it will leak another org's traffic.
 *
 * The same argument applies one level down: a `member` scope is constrained to
 * its own `user_id` by `scopeClause()`, once, rather than by each query
 * remembering to. A query that forgets to call `scopeClause()` cannot compile
 * into anything useful, since it would have no WHERE fragment and no params.
 *
 * ── The rollup table's dimension convention (READ THIS) ─────────────────────
 *
 * `usage_hourly` is treated as a FULLY-DIMENSIONED fact table: one row per
 * (hour_start, user_id, served_model, credential_origin, cost_basis) tuple that
 * was actually observed, and `''` means "this attribute was absent on the raw
 * request" (a NULL `user_id` is an unattributed request; a NULL `served_model`
 * is a call that never got far enough to have one).
 *
 * It is NOT read as a cube with pre-aggregated "all" roll-up rows per
 * dimension. Under that alternative reading every query here would have to pin
 * the dimensions it is not grouping by to `''`, the writer would have to emit
 * 2^4 rows per hour, and — fatally — `user_id = ''` would mean both "all users"
 * and "unattributed", which is exactly the distinction an admin needs (see
 * `usageByUser`). So: totals SUM every row in range; a breakdown GROUPs BY the
 * dimension it names. If the writer ever starts emitting "all" rows, every
 * total in this file doubles, loudly — see the raw/rollup agreement test.
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
 * The single tenancy gate.
 *
 * `alias` is the table alias so the fragment can be spliced into a join. Note
 * that for a member we emit `user_id = ?`, which in SQL also excludes NULL
 * rows — that is correct and deliberate: an unattributed request is not
 * provably the member's, and we never guess who it was. An admin sees those
 * rows; the member does not.
 *
 * Fails closed: a `member` scope with no `userId` is a bug in the caller's
 * session handling, and answering it as though it were an admin would be the
 * exact leak this module exists to prevent.
 */
function scopeClause(scope: Scope, alias: string): Clause {
  const params: Param[] = [scope.orgId];
  let sql = `${alias}.org_id = ?`;
  if (scope.role === "member") {
    if (!scope.userId) {
      throw new Error("member scope requires a userId; refusing to widen to org-wide");
    }
    sql += ` AND ${alias}.user_id = ?`;
    params.push(scope.userId);
  }
  return { sql, params };
}

// ── Source selection ──────────────────────────────────────────────────────────

export type Source = "requests" | "usage_hourly";

/**
 * How recent a range has to be before we bypass the rollups and read raw rows.
 *
 * Two hours, because the hourly rollup lags *by definition*: the current hour's
 * row is still accumulating, and the metering writer flushes in batches, so the
 * most recent bucket is always incomplete. A "last 30 minutes" panel served
 * from `usage_hourly` would under-report and look like an outage. Two hours
 * gives one complete hour plus the in-flight one, which is enough that any
 * range long enough to be a *trend* reads the rollups instead — and those
 * survive raw-row retention deletion, which is the whole point of having them.
 */
export const RAW_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * ONE place decides raw-vs-rollup. Every screen calls this rather than picking
 * its own threshold, so two panels on the same page can never disagree about
 * where "today" comes from.
 */
export function chooseSource(range: TimeRange): Source {
  return range.toMs - range.fromMs <= RAW_WINDOW_MS ? "requests" : "usage_hourly";
}

const HOUR_MS = 60 * 60 * 1000;

/** Floor to the containing hour bucket. */
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
// `node:sqlite` hands back loosely-typed records, and REAL/INTEGER columns can
// arrive as number or bigint depending on magnitude. These helpers are the only
// place that deals with it, so no query body has a cast in it.

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
 * `limit` arrives from a query string, so it is `unknown` in practice: coerce
 * to an integer and clamp. Not doing this is how `LIMIT ?` becomes a
 * full-table export.
 */
function clampLimit(limit: number | undefined): number {
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Sentinel for "no cursor yet". Binding a cursor on every call keeps the SQL a
 * single shape, which matters for the query plan: with `seq < ?` present SQLite
 * drives the query off a bounded descending rowid search, whereas the
 * cursor-less variant falls back to a temp b-tree sort.
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
 * Build the feed SQL and params. Split out from `listRequests` so the query
 * plan test can assert on the exact statement the app runs, rather than on a
 * hand-written approximation of it that could drift.
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
  if (filter.errorsOnly) {
    // Matches the `requests_errors` partial index predicate exactly, which is
    // what makes the errors view read ~1% of the table.
    where += " AND r.error_type IS NOT NULL";
  }

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
 * reader — they see a row twice and miss another. `seq < cursor` is stable
 * under concurrent inserts, and costs the same at page 1 and page 900.
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
  // guaranteed-empty request on every feed.
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
 *    would say "this was free", and averaging or forecasting over it would be
 *    wrong. It must never be added into a dollar total, so it is excluded from
 *    the sum (`CASE ... THEN NULL`, defensive in case a notional price was ever
 *    written into the column) and counted separately instead.
 *
 * With all three, a caller can render "$12.3456 (+3 n/a)" — see
 * `formatCostSum` in server/usage/cost.ts, which is the intended consumer.
 */
const RAW_AGG = `
  COUNT(*) AS requests,
  COALESCE(SUM(CASE WHEN r.error_type IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors,
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

function toTotals(row: Row): UsageTotals {
  const usage: UsagePayload = {
    inputTokens: num(row["input_tokens"]),
    cacheReadTokens: num(row["cache_read_tokens"]),
    cacheWrite5mTokens: num(row["cache_write_5m_tokens"]),
    cacheWrite1hTokens: num(row["cache_write_1h_tokens"]),
    outputTokens: num(row["output_tokens"]),
    webSearches: num(row["web_searches"]),
  };
  return {
    requests: num(row["requests"]),
    errors: num(row["errors"]),
    usage,
    pricedCostUsd: num(row["priced_cost_usd"]),
    unpricedRequests: num(row["unpriced_requests"]),
    subscriptionRequests: num(row["subscription_requests"]),
    // Single definition of cache hit ratio, in server/usage/pricing.ts. Do not
    // re-derive it here: the denominator is the four disjoint context buckets,
    // and getting that wrong is the classic double-count.
    cacheHitRatio: cacheHitRatio(usage),
  };
}

const EMPTY_TOTALS_ROW: Row = {};

/**
 * Build an aggregate query over whichever source `chooseSource` picked.
 *
 * `extraSelect`/`groupBy` let the breakdowns share one body, so a fix to the
 * cost arithmetic lands in every panel at once instead of five out of six.
 */
function aggregateQuery(
  scope: Scope,
  range: TimeRange,
  opts: {
    readonly rawSelect?: string;
    readonly rollupSelect?: string;
    readonly rawJoin?: string;
    readonly rollupJoin?: string;
    readonly groupBy?: string;
    readonly orderBy?: string;
  } = {},
): { sql: string; params: Param[] } {
  const source = chooseSource(range);
  if (source === "requests") {
    const scoped = scopeClause(scope, "r");
    const time = rawRange(range);
    const select = opts.rawSelect ? `${opts.rawSelect}, ${RAW_AGG}` : RAW_AGG;
    return {
      sql: `SELECT ${select}
        FROM requests r${opts.rawJoin ?? ""}
        WHERE ${scoped.sql} AND ${time.sql}
        ${opts.groupBy ? `GROUP BY ${opts.groupBy}` : ""}
        ${opts.orderBy ? `ORDER BY ${opts.orderBy}` : ""}`,
      params: [...scoped.params, ...time.params],
    };
  }
  const scoped = scopeClause(scope, "h");
  const time = rollupRange(range);
  const select = opts.rollupSelect ? `${opts.rollupSelect}, ${ROLLUP_AGG}` : ROLLUP_AGG;
  return {
    sql: `SELECT ${select}
      FROM usage_hourly h${opts.rollupJoin ?? ""}
      WHERE ${scoped.sql} AND ${time.sql}
      ${opts.groupBy ? `GROUP BY ${opts.groupBy}` : ""}
      ${opts.orderBy ? `ORDER BY ${opts.orderBy}` : ""}`,
    params: [...scoped.params, ...time.params],
  };
}

export function usageTotals(store: Store, scope: Scope, range: TimeRange): UsageTotals {
  const { sql, params } = aggregateQuery(scope, range);
  const row = store.db.prepare(sql).get(...params) as Row | undefined;
  return toTotals(row ?? EMPTY_TOTALS_ROW);
}

/**
 * Per-user totals.
 *
 * LEFT JOIN, not JOIN, and it has to stay that way: `requests.user_id` is
 * nullable because a call with no identity token is recorded as unattributed
 * rather than dropped, and `usage_hourly.user_id` carries `''` for the same
 * rows. An inner join would hide them, and unattributed usage is precisely what
 * an admin needs to SEE — it means a developer is pointing Claude Code at Fest
 * without an identity token, so their spend is landing in nobody's column.
 * Those rows surface as `userId: ''` with `email: null`.
 */
export function usageByUser(
  store: Store,
  scope: Scope,
  range: TimeRange,
): Array<{ userId: string; email: string | null } & UsageTotals> {
  const { sql, params } = aggregateQuery(scope, range, {
    rawSelect: "COALESCE(r.user_id, '') AS user_id, MAX(u.email) AS email",
    rollupSelect: "h.user_id AS user_id, MAX(u.email) AS email",
    // The join is scoped by org too. Belt and braces: user ids are prefixed
    // uuids so a cross-org collision is not realistic, but a join that can only
    // ever match within the tenant is one less thing to reason about.
    rawJoin: " LEFT JOIN users u ON u.id = r.user_id AND u.org_id = r.org_id",
    rollupJoin: " LEFT JOIN users u ON u.id = h.user_id AND u.org_id = h.org_id",
    groupBy: chooseSource(range) === "requests" ? "COALESCE(r.user_id, '')" : "h.user_id",
    orderBy: "requests DESC",
  });
  return (store.db.prepare(sql).all(...params) as Row[]).map((row) => ({
    userId: str(row["user_id"]),
    email: strOrNull(row["email"]),
    ...toTotals(row),
  }));
}

export function usageByModel(
  store: Store,
  scope: Scope,
  range: TimeRange,
): Array<{ servedModel: string } & UsageTotals> {
  const { sql, params } = aggregateQuery(scope, range, {
    rawSelect: "COALESCE(r.served_model, '') AS served_model",
    rollupSelect: "h.served_model AS served_model",
    groupBy: chooseSource(range) === "requests" ? "COALESCE(r.served_model, '')" : "h.served_model",
    orderBy: "requests DESC",
  });
  return (store.db.prepare(sql).all(...params) as Row[]).map((row) => ({
    servedModel: str(row["served_model"]),
    ...toTotals(row),
  }));
}

/**
 * Per-credential-origin totals. This is the compliance view: it answers "how
 * much of our traffic ran on a server-held key" in one glance, and
 * `distinctUsers` answers "how many people did that affect".
 *
 * `COUNT(DISTINCT user_id)` ignores NULLs on the raw path, and the rollup path
 * excludes `''` explicitly — an unattributed row is not a person we can count.
 */
export function usageByCredentialOrigin(
  store: Store,
  scope: Scope,
  range: TimeRange,
): Array<{ credentialOrigin: string; distinctUsers: number } & UsageTotals> {
  const { sql, params } = aggregateQuery(scope, range, {
    rawSelect: "r.credential_origin AS credential_origin, COUNT(DISTINCT r.user_id) AS distinct_users",
    rollupSelect:
      "h.credential_origin AS credential_origin, " +
      "COUNT(DISTINCT CASE WHEN h.user_id <> '' THEN h.user_id END) AS distinct_users",
    groupBy: chooseSource(range) === "requests" ? "r.credential_origin" : "h.credential_origin",
    orderBy: "requests DESC",
  });
  return (store.db.prepare(sql).all(...params) as Row[]).map((row) => ({
    credentialOrigin: str(row["credential_origin"]),
    distinctUsers: num(row["distinct_users"]),
    ...toTotals(row),
  }));
}

/**
 * Hourly series for a sparkline. Gaps are gaps: an hour with no traffic is
 * absent rather than zero-filled, because the caller knows the range and can
 * fill it, whereas this layer cannot tell "no traffic" from "outside retention".
 */
export function usageSeries(
  store: Store,
  scope: Scope,
  range: TimeRange,
): Array<{ hourStart: number } & UsageTotals> {
  const raw = chooseSource(range) === "requests";
  const { sql, params } = aggregateQuery(scope, range, {
    // Integer division truncates in SQLite, which is exactly the bucketing we
    // want, and it keeps the arithmetic in epoch ms with no timezone anywhere.
    rawSelect: `(r.started_at / ${HOUR_MS}) * ${HOUR_MS} AS hour_start`,
    rollupSelect: "h.hour_start AS hour_start",
    groupBy: raw ? `r.started_at / ${HOUR_MS}` : "h.hour_start",
    orderBy: "hour_start ASC",
  });
  return (store.db.prepare(sql).all(...params) as Row[]).map((row) => ({
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
 * "Error" is defined as `error_type IS NOT NULL`, matching the
 * `requests_errors` partial index predicate and the rollup's `errors` column,
 * so the count here and the count in `usageTotals` cannot drift apart.
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
    WHERE ${scoped.sql} AND ${time.sql} AND r.error_type IS NOT NULL
    GROUP BY r.error_type, r.http_status
    ORDER BY count DESC, error_type ASC`;
  const params = [...scoped.params, ...time.params];
  return (store.db.prepare(sql).all(...params) as Row[]).map((row) => ({
    errorType: strOrNull(row["error_type"]),
    httpStatus: numOrNull(row["http_status"]),
    count: num(row["count"]),
  }));
}

// ── Latency ───────────────────────────────────────────────────────────────────

/**
 * Lower edges of the fixed histogram buckets from `usage_hourly`: <1s, <3s,
 * <10s, <30s, <60s, >=60s. The last bucket is open-ended on purpose — a
 * gateway relaying agent turns has a genuinely unbounded tail, and inventing an
 * upper edge for it would invent a percentile.
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
   * buckets on the rollup path. See `latencySummary`. Never label the bucketed
   * figure as exact in a UI.
   */
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly buckets: readonly number[];
}

/**
 * Linear interpolation of a percentile within the fixed buckets.
 *
 * Why buckets exist at all: PERCENTILES DO NOT MERGE ACROSS ROLLUP ROWS. You
 * cannot average two hours' p95s, or pick the larger, and get the p95 of the
 * two hours combined — the information needed to do that was thrown away when
 * each hour was summarised. Bucket COUNTS, on the other hand, simply add. So
 * the rollup stores counts and we reconstruct a percentile from them.
 *
 * The reconstruction assumes latency is uniformly distributed inside each
 * bucket, which it is not. The result is therefore an ESTIMATE with a
 * resolution no finer than the bucket it lands in: a p95 reported as 24.5s
 * really means "somewhere in 10s–30s". Present it as approximate. If you need
 * an exact p95, shorten the range so `chooseSource` reads raw rows.
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
  // Unreachable while total > 0, but returning the top edge beats returning
  // null and having a caller read it as "no data".
  return LAT_LOWER[LAT_LOWER.length - 1] ?? null;
}

/** Nearest-rank percentile over a sorted array. No interpolation, no estimate. */
function exactPercentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(p * sorted.length) - 1;
  const idx = Math.min(Math.max(rank, 0), sorted.length - 1);
  return sorted[idx] ?? null;
}

export function latencySummary(store: Store, scope: Scope, range: TimeRange): LatencySummary {
  if (chooseSource(range) === "requests") {
    const scoped = scopeClause(scope, "r");
    const time = rawRange(range);
    const params = [...scoped.params, ...time.params];
    // Pulling the durations out and sorting in JS is fine here *because* this
    // branch only runs for ranges of <= RAW_WINDOW_MS. Do not reuse it for a
    // long range: that is what the bucketed branch below is for.
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
      let i = LAT_BUCKET_COUNT - 1;
      for (let b = 0; b < LAT_BUCKET_COUNT; b += 1) {
        const upper = LAT_UPPER[b];
        if (upper === null || upper === undefined || d < upper) {
          i = b;
          break;
        }
      }
      buckets[i] = (buckets[i] ?? 0) + 1;
    }

    return {
      count: num(agg?.["count"]),
      avgDurationMs: numOrNull(agg?.["avg_duration"]),
      maxDurationMs: numOrNull(agg?.["max_duration"]),
      avgTtfbMs: numOrNull(agg?.["avg_ttfb"]),
      p50Ms: exactPercentile(durations, 0.5),
      p95Ms: exactPercentile(durations, 0.95),
      buckets,
    };
  }

  const scoped = scopeClause(scope, "h");
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
       FROM usage_hourly h WHERE ${scoped.sql} AND ${time.sql}`,
    )
    .get(...scoped.params, ...time.params) as Row | undefined;

  const r = row ?? EMPTY_TOTALS_ROW;
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
 * For a developer on a subscription this — not dollars — is the scarce
 * resource, so it gets its own panel. There is no time range: the question is
 * always "where does everyone stand right now", and the answer is whatever the
 * most recent request that actually CARRIED quota headers reported.
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

/**
 * Per-user rollup SQL, exposed for the query plan test. See `feedSql` for why
 * the test asserts on the real statement rather than a copy of it.
 */
export function usageByUserSql(scope: Scope, range: TimeRange): { sql: string; params: Param[] } {
  return aggregateQuery(scope, range, {
    rawSelect: "COALESCE(r.user_id, '') AS user_id, MAX(u.email) AS email",
    rollupSelect: "h.user_id AS user_id, MAX(u.email) AS email",
    rawJoin: " LEFT JOIN users u ON u.id = r.user_id AND u.org_id = r.org_id",
    rollupJoin: " LEFT JOIN users u ON u.id = h.user_id AND u.org_id = h.org_id",
    groupBy: chooseSource(range) === "requests" ? "COALESCE(r.user_id, '')" : "h.user_id",
    orderBy: "requests DESC",
  });
}
