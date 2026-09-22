/**
 * The metering write path.
 *
 * Called from the flush side of the usage queue, never from a proxied request
 * (see the constraint comment in db.ts — `DatabaseSync` blocks the event loop).
 * One batch is one transaction, and inside it each record writes both its raw
 * `requests` row and its `usage_hourly` rollups, so the rollups can never
 * disagree with the rows they summarise.
 *
 * Two principles run through this file:
 *
 *  1. METERING MUST DEGRADE, NEVER TAKE DOWN THE PROXY. A malformed record is
 *     logged and skipped; it never fails its batch and never escapes as an
 *     exception into the caller. Losing one row of observability is a nuisance;
 *     killing the gateway that developers are actively coding against is an
 *     outage.
 *  2. COST IS REPORTED HONESTLY. `costUsd === null` means "no dollar figure
 *     applies", not zero, and the rollup keeps three separate facts so that
 *     distinction survives aggregation.
 */

import type { UsageRecord } from "../../shared/types.ts";
import { isErrorStatus } from "../../shared/types.ts";
import type { Store } from "./db.ts";
import { log } from "../log.ts";

export interface RequestWriter {
  /** Insert N records and update their hourly rollups in ONE transaction. */
  writeBatch(orgId: string, records: readonly UsageRecord[]): number;
}

/**
 * Identity attribution seam.
 *
 * `requests.user_id` / `requests.token_id` are nullable on purpose: a request
 * that arrived without a Fest identity token is recorded as UNATTRIBUTED rather
 * than dropped. We would rather have an org total that is complete with a
 * visible "unknown" slice than a total that is quietly short.
 *
 * These arrived on `UsageRecord` with identity resolution, which landed in
 * parallel with this file. The writer still reads them structurally rather than
 * requiring them, so it keeps working against a record built by a caller that
 * predates the field (the Phase 1 JSONL replay path, for one). Collapsing this
 * to a direct `record.userId` read is safe once nothing replays old records;
 * it is the only change needed.
 */
interface AttributedRecord {
  readonly userId?: string | null | undefined;
  readonly tokenId?: string | null | undefined;
}

const HOUR_MS = 3_600_000;

/** Epoch ms truncated to the start of its UTC hour. */
export function hourStart(epochMs: number): number {
  return Math.floor(epochMs / HOUR_MS) * HOUR_MS;
}

/**
 * Fixed latency histogram buckets: <1s, <3s, <10s, <30s, <60s, >=60s.
 *
 * Buckets rather than percentiles because bucket counts ADD across rollup rows
 * and percentiles do not: p95-of-p95s is not a number that means anything.
 */
export function latencyBucket(durationMs: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (durationMs < 1_000) return 0;
  if (durationMs < 3_000) return 1;
  if (durationMs < 10_000) return 2;
  if (durationMs < 30_000) return 3;
  if (durationMs < 60_000) return 4;
  return 5;
}

/** '' is the "all" bucket sentinel for a rollup dimension (see 001-init.sql). */
const ALL = "";

const INSERT_REQUEST = `
INSERT INTO requests (
  id, org_id, user_id, token_id,
  started_at, ended_at,
  posture, identity_carrier, caller_fingerprint, credential_fingerprint, credential_origin,
  session_id,
  requested_model, served_model, upstream,
  stream, status, http_status, error_type, error_message, partial,
  input_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
  output_tokens, web_searches, service_tier,
  cost_usd, cost_basis, notional_cost_usd,
  ttfb_ms, duration_ms, bytes_in, bytes_out,
  upstream_request_id,
  rl_status, rl_5h_utilization, rl_5h_status, rl_5h_reset_at,
  rl_7d_utilization, rl_7d_status, rl_7d_reset_at,
  rl_claim, rl_overage_status, rl_overage_reason,
  client_version,
  pipeline, route_id, credentials_considered
) VALUES (
  :id, :org_id, :user_id, :token_id,
  :started_at, :ended_at,
  :posture, :identity_carrier, :caller_fingerprint, :credential_fingerprint, :credential_origin,
  :session_id,
  :requested_model, :served_model, :upstream,
  :stream, :status, :http_status, :error_type, :error_message, :partial,
  :input_tokens, :cache_read_tokens, :cache_write_5m_tokens, :cache_write_1h_tokens,
  :output_tokens, :web_searches, :service_tier,
  :cost_usd, :cost_basis, :notional_cost_usd,
  :ttfb_ms, :duration_ms, :bytes_in, :bytes_out,
  :upstream_request_id,
  :rl_status, :rl_5h_utilization, :rl_5h_status, :rl_5h_reset_at,
  :rl_7d_utilization, :rl_7d_status, :rl_7d_reset_at,
  :rl_claim, :rl_overage_status, :rl_overage_reason,
  :client_version,
  :pipeline, :route_id, :credentials_considered
)`;

const ADDITIVE_COLUMNS = [
  "requests",
  "errors",
  "input_tokens",
  "cache_read_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
  "output_tokens",
  "web_searches",
  "cost_usd",
  "unpriced_requests",
  "subscription_requests",
  "notional_cost_usd",
  "notional_unpriced_requests",
  "duration_ms_sum",
  "ttfb_ms_sum",
  "ttfb_count",
  "lat_b0",
  "lat_b1",
  "lat_b2",
  "lat_b3",
  "lat_b4",
  "lat_b5",
] as const;

const KEY_COLUMNS = [
  "org_id",
  "hour_start",
  "user_id",
  "served_model",
  "credential_origin",
  "cost_basis",
] as const;

const ROLLUP_COLUMNS = [...KEY_COLUMNS, ...ADDITIVE_COLUMNS, "duration_ms_max"];

const UPSERT_ROLLUP = `
INSERT INTO usage_hourly (${ROLLUP_COLUMNS.join(", ")})
VALUES (${ROLLUP_COLUMNS.map((c) => ":" + c).join(", ")})
ON CONFLICT(${KEY_COLUMNS.join(", ")}) DO UPDATE SET
  ${ADDITIVE_COLUMNS.map((c) => `${c} = ${c} + excluded.${c}`).join(",\n  ")},
  duration_ms_max = MAX(duration_ms_max, excluded.duration_ms_max)`;

/** Booleans are stored as INTEGER 0/1 per the schema's convention. */
function bit(value: boolean): number {
  return value ? 1 : 0;
}

/** `undefined` and missing values collapse to SQL NULL; 0 and '' are preserved. */
function nullable<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value;
}

type Params = Record<string, string | number | null>;

function requestParams(orgId: string, record: UsageRecord): Params {
  const usage = record.usage;
  const rl = record.rateLimit;
  const attributed = record as UsageRecord & AttributedRecord;

  // Read every field eagerly so a malformed record (missing `usage`, say)
  // throws HERE, before any statement has run, and the skip is clean.
  return {
    id: record.id,
    org_id: orgId,
    user_id: nullable(attributed.userId),
    token_id: nullable(attributed.tokenId),
    started_at: record.startedAt,
    ended_at: record.endedAt,
    posture: record.posture,
    identity_carrier: record.identityCarrier,
    caller_fingerprint: nullable(record.callerFingerprint),
    credential_fingerprint: nullable(record.credentialFingerprint),
    credential_origin: record.credentialOrigin,
    session_id: nullable(record.sessionId),
    requested_model: nullable(record.requestedModel),
    served_model: nullable(record.servedModel),
    upstream: record.upstream,
    stream: bit(record.stream),
    status: record.status,
    http_status: nullable(record.httpStatus),
    error_type: nullable(record.errorType),
    error_message: nullable(record.errorMessage),
    partial: bit(record.partial),
    input_tokens: usage.inputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_5m_tokens: usage.cacheWrite5mTokens,
    cache_write_1h_tokens: usage.cacheWrite1hTokens,
    output_tokens: usage.outputTokens,
    web_searches: usage.webSearches,
    service_tier: nullable(usage.serviceTier),
    cost_usd: nullable(record.costUsd),
    cost_basis: record.costBasis,
    notional_cost_usd: nullable(record.notionalCostUsd),
    ttfb_ms: nullable(record.ttfbMs),
    duration_ms: record.durationMs,
    bytes_in: record.bytesIn,
    bytes_out: record.bytesOut,
    upstream_request_id: nullable(record.upstreamRequestId),
    rl_status: nullable(rl?.status),
    rl_5h_utilization: nullable(rl?.fiveHourUtilization),
    rl_5h_status: nullable(rl?.fiveHourStatus),
    rl_5h_reset_at: nullable(rl?.fiveHourResetAt),
    rl_7d_utilization: nullable(rl?.sevenDayUtilization),
    rl_7d_status: nullable(rl?.sevenDayStatus),
    rl_7d_reset_at: nullable(rl?.sevenDayResetAt),
    rl_claim: nullable(rl?.representativeClaim),
    rl_overage_status: nullable(rl?.overageStatus),
    rl_overage_reason: nullable(rl?.overageDisabledReason),
    client_version: nullable(record.clientVersion),
    pipeline: record.pipeline,
    route_id: nullable(record.routeId),
    // Serialised here rather than in the request path: the array is small, but
    // pricing and persistence both belong in the flush, and this is both.
    credentials_considered: JSON.stringify(record.credentialsConsidered ?? []),
  };
}

function rollupParams(orgId: string, record: UsageRecord): Params[] {
  const usage = record.usage;
  const attributed = record as UsageRecord & AttributedRecord;
  const userId = attributed.userId ?? ALL;
  // served_model is NOT NULL in the rollup, so an unresolved model lands in the
  // same '' bucket as "all models". That is a deliberate collapse, and it is
  // why the four keys below are de-duplicated before writing.
  const servedModel = record.servedModel ?? ALL;

  // ── Cost honesty ──────────────────────────────────────────────────────────
  // Three mutually exclusive facts, because one number cannot carry them:
  //   cost_usd              dollars the org actually owes, priced rows only
  //   subscription_requests real usage the developer's own plan absorbed
  //   unpriced_requests     usage we could not price (unknown model)
  // Collapsing either counter into cost_usd as 0 would make a dashboard read
  // "$0.00" for a month of heavy subscription traffic, which is a lie of the
  // most convincing kind. SUM() over a nullable cost column skips NULLs
  // silently — that is exactly the understatement this split prevents.
  const priced = typeof record.costUsd === "number" && Number.isFinite(record.costUsd);
  const isSubscription = record.costBasis === "subscription";
  const costUsd = priced ? record.costUsd : 0;
  const subscriptionRequests = isSubscription ? 1 : 0;
  // Keyed off `!priced` rather than `costUsd === null` so a non-finite cost
  // (NaN/Infinity from a bad rate table) is still counted as unpriced. With the
  // narrower `=== null` test such a record would be excluded from the dollar
  // sum AND from the n/a count — vanishing from the books entirely, which is
  // precisely the silent understatement this split exists to prevent.
  const unpricedRequests = !priced && !isSubscription ? 1 : 0;

  // Notional value runs on its own books, and the asymmetry is the whole point:
  // subscription rows are EXCLUDED from cost_usd and INCLUDED here. A model
  // with no published rate is unknown on both, so it gets the same
  // lower-bound counter treatment, keyed off `!notionalPriced` for the same
  // NaN reason as above.
  const notionalPriced =
    typeof record.notionalCostUsd === "number" && Number.isFinite(record.notionalCostUsd);
  const notionalCostUsd = notionalPriced ? (record.notionalCostUsd ?? 0) : 0;
  const notionalUnpricedRequests = notionalPriced ? 0 : 1;

  const bucket = latencyBucket(record.durationMs);
  // ttfb is only summed when it exists, so `ttfb_ms_sum / ttfb_count` is an
  // average over requests that actually produced a first byte rather than one
  // diluted by aborts and non-streaming calls.
  const hasTtfb = typeof record.ttfbMs === "number";

  const shared: Params = {
    org_id: orgId,
    hour_start: hourStart(record.startedAt),
    credential_origin: record.credentialOrigin,
    cost_basis: record.costBasis,
    requests: 1,
    // Shared with the raw-range predicate in `queries.ts`; see NON_ERROR_STATUSES.
    errors: isErrorStatus(record.status) ? 1 : 0,
    input_tokens: usage.inputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_5m_tokens: usage.cacheWrite5mTokens,
    cache_write_1h_tokens: usage.cacheWrite1hTokens,
    output_tokens: usage.outputTokens,
    web_searches: usage.webSearches,
    cost_usd: costUsd ?? 0,
    unpriced_requests: unpricedRequests,
    subscription_requests: subscriptionRequests,
    notional_cost_usd: notionalCostUsd,
    notional_unpriced_requests: notionalUnpricedRequests,
    duration_ms_sum: record.durationMs,
    duration_ms_max: record.durationMs,
    ttfb_ms_sum: hasTtfb ? (record.ttfbMs ?? 0) : 0,
    ttfb_count: hasTtfb ? 1 : 0,
    lat_b0: bucket === 0 ? 1 : 0,
    lat_b1: bucket === 1 ? 1 : 0,
    lat_b2: bucket === 2 ? 1 : 0,
    lat_b3: bucket === 3 ? 1 : 0,
    lat_b4: bucket === 4 ? 1 : 0,
    lat_b5: bucket === 5 ? 1 : 0,
  };

  // Four buckets per record, so every dashboard query is a point lookup or a
  // narrow range scan instead of a GROUP BY over the raw hot table:
  //   (user, model)  the specific cell
  //   (user, '')     one developer, all models
  //   ('', model)    all developers, one model
  //   ('', '')       org totals
  const keys: ReadonlyArray<readonly [string, string]> = [
    [userId, servedModel],
    [userId, ALL],
    [ALL, servedModel],
    [ALL, ALL],
  ];

  // De-duplicate: when the record is unattributed (userId '') or its model is
  // unknown (servedModel ''), two or more of the four keys are the SAME primary
  // key, and writing both would double-count that record via the upsert's
  // `col = col + excluded.col`. Do not remove this.
  const seen = new Set<string>();
  const rows: Params[] = [];
  for (const [u, m] of keys) {
    const key = `${u}\u0000${m}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ ...shared, user_id: u, served_model: m });
  }
  return rows;
}

export function createRequestWriter(store: Store): RequestWriter {
  // Prepared ONCE and reused for the process lifetime. Re-preparing per row is
  // the difference between roughly 1ms and 50ms for a 200-row batch: parsing
  // and planning a 46-column INSERT dominates actually executing it.
  const insertRequest = store.db.prepare(INSERT_REQUEST);
  const upsertRollup = store.db.prepare(UPSERT_ROLLUP);
  insertRequest.setAllowBareNamedParameters(true);
  upsertRollup.setAllowBareNamedParameters(true);

  return {
    writeBatch(orgId: string, records: readonly UsageRecord[]): number {
      if (records.length === 0) return 0;

      let written = 0;
      store.transaction(() => {
        for (const record of records) {
          try {
            // Build all parameters for this record BEFORE executing anything.
            // A malformed record then fails with nothing written, which keeps
            // the row/rollup invariant without needing a SAVEPOINT per row.
            const reqParams = requestParams(orgId, record);
            const rollups = rollupParams(orgId, record);

            insertRequest.run(reqParams);
            for (const rollup of rollups) upsertRollup.run(rollup);
            written += 1;
          } catch (err) {
            // Per-record, inside the transaction: one bad record must not cost
            // us the other 199. The batch still commits.
            log.warn("usage record skipped", {
              id: typeof record?.id === "string" ? record.id : "<unknown>",
              err: String(err),
            });
          }
        }
      });

      return written;
    },
  };
}
