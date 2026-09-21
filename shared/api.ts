/**
 * The dashboard wire contract.
 *
 * Declared here rather than imported from `server/store/queries.ts` because the
 * browser bundle must not reach into server modules — that file's import graph
 * reaches `node:sqlite`. Declaring the shapes independently would normally
 * invite drift, so `server/api/routes.ts` asserts every response with
 * `satisfies`: if a query's return type stops matching what the dashboard is
 * promised, `tsc --noEmit` fails at the route rather than the browser failing at
 * runtime. Fields added server-side are invisible to the UI, which is harmless;
 * fields removed or renamed break the build, which is the direction that
 * matters.
 *
 * Accounting rules the UI must honour are documented on the fields themselves,
 * because a field named `pricedCostUsd` is otherwise indistinguishable from a
 * total.
 */

import type { UsagePayload, CostBasis, CredentialAttempt } from "./types.ts";

export interface TimeRangeWire {
  /** Inclusive, epoch ms. */
  readonly fromMs: number;
  /** Exclusive, epoch ms. */
  readonly toMs: number;
}

export interface UsageTotalsWire {
  readonly requests: number;
  readonly errors: number;
  readonly usage: UsagePayload;
  /**
   * Sum of the PRICED rows only, and therefore a LOWER BOUND whenever
   * `unpricedRequests > 0`. Never render it alone; never add subscription usage
   * into it.
   */
  readonly pricedCostUsd: number;
  readonly unpricedRequests: number;
  /** Real usage that produced no org spend. Counted, never priced. */
  readonly subscriptionRequests: number;
  readonly cacheHitRatio: number | null;
}

export interface RequestRowWire {
  /** Monotonic rowid; doubles as the keyset cursor. */
  readonly seq: number;
  readonly id: string;
  readonly startedAt: number;
  /** Null means unattributed — shown, never hidden. */
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
  /** Null means "no dollar figure applies or is available" — never `$0.00`. */
  readonly costUsd: number | null;
  readonly costBasis: CostBasis;
  readonly ttfbMs: number | null;
  readonly durationMs: number;
  readonly rl5hUtilization: number | null;
  readonly rlClaim: string | null;
  readonly clientVersion: string | null;
  /** `passthrough` or `substitute`. */
  readonly pipeline: string;
  /** The route that decided, or null when the default pass-through applied. */
  readonly routeId: string | null;
  /**
   * Every credential considered, in order. Present on every row — an empty
   * array means the row predates routing, not that nothing was considered.
   */
  readonly credentialsConsidered: readonly CredentialAttempt[];
}

export interface LatencySummaryWire {
  readonly count: number;
  readonly avgDurationMs: number | null;
  readonly maxDurationMs: number | null;
  readonly avgTtfbMs: number | null;
  /**
   * Exact on the raw path, INTERPOLATED from six fixed buckets on the rollup
   * path. The UI cannot tell which it got, so it must label both approximate.
   */
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  /** Counts for <1s, <3s, <10s, <30s, <60s, >=60s. */
  readonly buckets: readonly number[];
}

export interface QuotaSnapshotWire {
  readonly userId: string | null;
  readonly email: string | null;
  readonly observedAt: number;
  readonly fiveHourUtilization: number | null;
  readonly fiveHourStatus: string | null;
  readonly fiveHourResetAt: number | null;
  readonly sevenDayUtilization: number | null;
  readonly sevenDayStatus: string | null;
  readonly sevenDayResetAt: number | null;
  /** Which window is currently binding, per Anthropic. */
  readonly claim: string | null;
  readonly overageStatus: string | null;
  readonly overageReason: string | null;
}

export interface SinkStatsWire {
  readonly queued: number;
  readonly written: number;
  /** Non-zero means the dashboard is under-reporting. Never hide it. */
  readonly dropped: number;
  readonly writeErrors: number;
  readonly trailErrors: number;
  readonly lastFlushMs: number | null;
}

// ── Envelopes ─────────────────────────────────────────────────────────────────

export interface OverviewResponse {
  readonly range: TimeRangeWire;
  readonly totals: UsageTotalsWire;
  /** Hourly, with GAPS: an hour with no traffic is absent, not zero. */
  readonly series: ReadonlyArray<{ readonly hourStart: number } & UsageTotalsWire>;
  readonly byCredentialOrigin: ReadonlyArray<
    { readonly credentialOrigin: string; readonly distinctUsers: number } & UsageTotalsWire
  >;
  readonly latency: LatencySummaryWire;
  readonly sink: SinkStatsWire;
}

export interface RequestsResponse {
  readonly rows: readonly RequestRowWire[];
  readonly nextCursor: number | null;
}

export interface UsersResponse {
  readonly range: TimeRangeWire;
  /** `userId: ""` with `email: null` is the unattributed slice. */
  readonly rows: ReadonlyArray<
    { readonly userId: string; readonly email: string | null } & UsageTotalsWire
  >;
}

export interface ModelsResponse {
  readonly range: TimeRangeWire;
  /** `servedModel: ""` means the model was never resolved. */
  readonly rows: ReadonlyArray<{ readonly servedModel: string } & UsageTotalsWire>;
}

export interface ErrorsResponse {
  readonly range: TimeRangeWire;
  readonly rows: ReadonlyArray<{
    readonly errorType: string | null;
    readonly httpStatus: number | null;
    readonly count: number;
  }>;
  readonly latency: LatencySummaryWire;
}

export interface QuotaResponse {
  readonly rows: readonly QuotaSnapshotWire[];
}

// ── Routing ───────────────────────────────────────────────────────────────────

/**
 * The routing table as the dashboard sees it.
 *
 * Credentials appear as REFERENCES and a resolution status — never values.
 * That is not a redaction step applied on the way out; there is no value in the
 * table to redact. The config holds `{env:NAME}`, so the most this endpoint
 * could ever disclose is the NAME of an environment variable, which is what an
 * operator needs in order to fix a broken route.
 *
 * `credentialPresent` is worth the extra work: "this route is configured but
 * its key is not set on the server" is the single most common way routing is
 * broken, and without it the only way to find out is to send a request and
 * read the refusal.
 */
export interface UpstreamWire {
  readonly id: string;
  readonly adapter: string;
  readonly baseUrl: string;
  /** e.g. `env:FIREWORKS_API_KEY`. A name, never a secret. */
  readonly credentialSource: string;
  /** Whether that reference currently resolves to something non-empty. */
  readonly credentialPresent: boolean;
  /** What this adapter changes about a request, for the operator's benefit. */
  readonly transforms: readonly string[];
}

export interface RouteWire {
  readonly id: string;
  readonly match: string;
  /** Null means "deliberately kept on the pass-through path". */
  readonly upstream: string | null;
  /** Null means the requested model id is sent unchanged. */
  readonly model: string | null;
}

export interface RoutingResponse {
  /** Content hash of the loaded table; doubles as an ETag. */
  readonly version: string;
  /** False when no routing config is loaded — everything passes through. */
  readonly enabled: boolean;
  readonly upstreams: readonly UpstreamWire[];
  /** In evaluation order: exact rules first, then longest wildcard, then file order. */
  readonly routes: readonly RouteWire[];
}

/**
 * A row as it arrives on the live feed.
 *
 * `seq` is null because the feed is published from the sink's flush, before the
 * row's rowid is read back. That is not a gap to paper over with a fake cursor:
 * `seq` exists solely to page backwards through history, and a live row is by
 * definition at the head. The UI keys on `id` (unique) and pages only on the
 * `seq` values that came from `/api/requests`, so the two sources merge without
 * either pretending to be the other.
 */
export type LiveRowWire = Omit<RequestRowWire, "seq"> & { readonly seq: null };

/** One `/api/live` SSE frame: a whole flush batch, oldest-first. */
export interface LiveFrame {
  readonly rows: readonly LiveRowWire[];
}

/** Any row the feed can render, from either source. */
export type FeedRowWire = RequestRowWire | LiveRowWire;

/** `/api/auth/me`, and the body of a successful `/api/auth/login`. */
export interface MeResponse {
  readonly authenticated: boolean;
  readonly user?: {
    readonly id: string;
    readonly email: string;
    readonly role: "owner" | "admin" | "member";
  };
  /**
   * True when nobody has run `fest admin create` yet. The dashboard shows setup
   * instructions instead of a login form, because there is nothing to log in
   * with — and the API is only reachable at all because it is bound to
   * loopback.
   */
  readonly setupRequired: boolean;
}

/** One administrative action. Never contains a credential or any prompt text. */
export interface AuditRowWire {
  readonly seq: number;
  readonly at: number;
  readonly actorUserId: string | null;
  /** The email the actor presented — kept even if the user row is deleted. */
  readonly actorLabel: string;
  readonly action: string;
  readonly target: string;
  readonly outcome: "ok" | "denied" | "error";
  readonly detail: Record<string, unknown>;
  readonly ip: string;
}

export interface AuditResponse {
  readonly rows: readonly AuditRowWire[];
}
