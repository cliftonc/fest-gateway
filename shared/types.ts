/**
 * Fest wire and record contracts.
 *
 * Single source of truth for the shapes that cross module boundaries. Written
 * before the modules so parallel work cannot diverge.
 */

// ── Anthropic usage ────────────────────────────────────────────────────────────

/**
 * Token usage as Anthropic reports it.
 *
 * The four token buckets are DISJOINT BILLING BUCKETS. `inputTokens` excludes
 * both cache reads and cache writes. Context size is the sum of all four; cost
 * is each bucket at its own rate. Adding cache reads into input is the classic
 * double-count.
 */
export interface UsagePayload {
  /** Uncached input remainder only — excludes cache read and cache write. */
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
  readonly outputTokens: number;
  readonly webSearches: number;
  /** Anthropic's service tier, when reported (e.g. "standard", "priority"). */
  readonly serviceTier?: string | undefined;
}

export const EMPTY_USAGE: UsagePayload = Object.freeze({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  outputTokens: 0,
  webSearches: 0,
});

/** Total tokens that occupied the context window for this call. */
export function contextTokens(u: UsagePayload): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens;
}

// ── Server-sent events ────────────────────────────────────────────────────────

/**
 * One parsed SSE event. `data` is left as the raw string; only the event types
 * that carry usage are ever JSON-parsed, because content deltas are the bulk of
 * the bytes and parsing them would dominate proxy CPU.
 */
export interface SseEvent {
  readonly type: string;
  readonly data: string;
}

/** Event types Fest parses. Everything else is forwarded without inspection. */
export const USAGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message_start",
  "message_delta",
  "error",
]);

// ── Rate limit / quota ────────────────────────────────────────────────────────

/**
 * Anthropic's unified quota headers, observed on every response.
 *
 * For a subscription developer this — not dollars — is the scarce resource, so
 * it is a first-class record field rather than a diagnostic.
 */
export interface RateLimitSnapshot {
  readonly status?: string | undefined;
  readonly fiveHourUtilization?: number | undefined;
  readonly fiveHourStatus?: string | undefined;
  readonly fiveHourResetAt?: number | undefined;
  readonly sevenDayUtilization?: number | undefined;
  readonly sevenDayStatus?: string | undefined;
  readonly sevenDayResetAt?: number | undefined;
  /** Which window is currently binding, per Anthropic. */
  readonly representativeClaim?: string | undefined;
  readonly overageStatus?: string | undefined;
  readonly overageDisabledReason?: string | undefined;
}

// ── Posture and identity ──────────────────────────────────────────────────────

/**
 * Which credential model this request is using. Detected from the request
 * alone — never configured, because it is determined by the developer's own
 * client env.
 *
 * - `subscription`: the developer's own Max/Team OAuth bearer arrived. Body is
 *   forwarded byte-for-byte; no rewriting is permitted.
 * - `key`: an API-key-shaped credential arrived. Routing and rewriting allowed.
 */
export type Posture = "subscription" | "key";

/**
 * How the caller's Fest identity token reached us.
 *
 * `auth_header` is the KEY posture: the developer set
 * `ANTHROPIC_AUTH_TOKEN=fest_…`, so the token arrives as
 * `Authorization: Bearer fest_…`. That is a deliberate trade, not a fallback —
 * setting that variable is exactly what makes Claude Code abandon subscription
 * auth, so this carrier and a pass-through subscription are mutually exclusive
 * by construction. It buys the things a key-posture gateway can do that a
 * subscription one cannot: a server-published model menu, and no per-developer
 * setup beyond one environment variable.
 */
export type IdentityCarrier = "path" | "header" | "auth_header" | "none";

export interface Identity {
  readonly carrier: IdentityCarrier;
  /** Fingerprint only. The raw token is never retained past authentication. */
  readonly tokenFingerprint: string | null;
}

// ── Usage records ─────────────────────────────────────────────────────────────

export type RequestStatus =
  | "ok"
  | "client_abort"
  | "stream_error"
  | "upstream_error"
  | "identity_denied"
  | "bad_request"
  /**
   * Anthropic refused Claude Code's session-start warmup ping on a
   * subscription bearer. Recorded, never counted as a failure.
   *
   * See `server/pipeline/preflight.ts` for the exact predicate and the capture
   * that established it. Its own status rather than a suppressed row, because
   * "this happened and it is expected" is a different claim from "this did not
   * happen", and only one of them is true.
   */
  | "preflight_refused";

/**
 * Statuses that are NOT failures — the single definition, in the one place both
 * the writer and the query layer can import.
 *
 * `server/store/write.ts` increments `usage_hourly.errors` from this, and
 * `server/store/queries.ts` builds its raw-range SQL predicate from it. They
 * must agree exactly: the rollup takes over at 2 hours, so a disagreement makes
 * the same range report different error counts depending on which side of that
 * threshold it falls on. Keeping the list here rather than writing the
 * condition out twice is what stops the two drifting.
 */
export const NON_ERROR_STATUSES = ["ok", "preflight_refused"] as const satisfies
  readonly RequestStatus[];

export function isErrorStatus(status: RequestStatus): boolean {
  return !(NON_ERROR_STATUSES as readonly string[]).includes(status);
}

/**
 * Where the credential that served this request came from.
 *
 * `inbound_subscription` means the developer's own subscription paid for it.
 * `fallback_server` means Fest substituted a server-held key — which is real
 * org spend, and must never happen silently.
 */
export type CredentialOrigin = "inbound_subscription" | "inbound_key" | "fallback_server" | "none";

/**
 * Basis for the cost figure.
 *
 * `subscription` means no dollar cost applies — the developer's subscription
 * absorbed it. That is NOT the same as zero, and must never be summed into
 * org spend.
 */
export type CostBasis = "subscription" | "list" | "none";

// ── Credential resolution ─────────────────────────────────────────────────────

/**
 * What happened to one candidate credential.
 *
 * `source` is a REFERENCE, never a value: `"inbound_subscription"`,
 * `"env:FIREWORKS_API_KEY"`, `"upstream:fireworks"`. There is no shape here a
 * secret could occupy, which is the point — this record is written to the
 * database and rendered in a browser.
 */
export type CredentialResult =
  /** This is the credential the request was sent with. At most one per record. */
  | "used"
  /** Configured, but nothing was there to read. */
  | "missing"
  /** Present but refused upstream (401/403). */
  | "rejected"
  /** Not eligible on this path — e.g. an inbound bearer on a substitute route. */
  | "skipped";

export interface CredentialAttempt {
  readonly source: string;
  readonly result: CredentialResult;
  /** Why, in a few words, when the result alone is not self-explanatory. */
  readonly reason?: string | undefined;
}

/**
 * Which pipeline served a request.
 *
 * `passthrough` forwards bytes verbatim to Anthropic on the caller's own
 * credential. `substitute` sends a rewritten request to another provider on a
 * credential the SERVER holds — which is org spend, and a different vendor
 * seeing the traffic. The two are never allowed to blur into one another.
 */
export type Pipeline = "passthrough" | "substitute";

export interface UsageRecord {
  readonly id: string;
  readonly startedAt: number;
  readonly endedAt: number;

  readonly posture: Posture;
  readonly identityCarrier: IdentityCarrier;
  readonly callerFingerprint: string | null;
  /**
   * Resolved identity, when the presented token matched a live one.
   *
   * Null means unattributed: the request was served but we do not know who
   * made it. We never guess — an unattributed row is a signal an admin needs to
   * see (someone is not using an identity token), so it is recorded rather
   * than dropped.
   */
  readonly userId: string | null;
  readonly tokenId: string | null;
  /** Fingerprint of the upstream credential. Never the credential itself. */
  readonly credentialFingerprint: string | null;
  readonly credentialOrigin: CredentialOrigin;

  /** Claude Code's own session id, from `x-claude-code-session-id`. */
  readonly sessionId: string | null;

  readonly requestedModel: string | null;
  readonly servedModel: string | null;
  readonly upstream: string;

  readonly stream: boolean;
  readonly status: RequestStatus;
  readonly httpStatus: number | null;
  readonly errorType?: string | undefined;
  readonly errorMessage?: string | undefined;
  /** True when the stream ended early, so usage is incomplete but real. */
  readonly partial: boolean;

  readonly usage: UsagePayload;
  readonly costUsd: number | null;
  readonly costBasis: CostBasis;
  /**
   * What this call would have cost at published API rates.
   *
   * VALUE, NOT SPEND. On the subscription path `costUsd` is null and this is
   * populated: the developer's own plan absorbed the call, so there is no org
   * invoice, but the work still had a market price worth showing. It must never
   * be summed into, compared against, or substituted for `costUsd` — doing so
   * fabricates an invoice for money nobody was charged.
   *
   * Null means the model has no published rate, so the value is genuinely
   * unknown. Null is not zero here either.
   */
  readonly notionalCostUsd: number | null;

  readonly ttfbMs: number | null;
  readonly durationMs: number;
  readonly bytesIn: number;
  readonly bytesOut: number;

  readonly upstreamRequestId: string | null;
  readonly rateLimit: RateLimitSnapshot | null;

  readonly clientVersion: string | null;

  readonly pipeline: Pipeline;
  /**
   * The route that made the decision, or null when no route matched and the
   * default (passthrough) applied.
   */
  readonly routeId: string | null;

  /**
   * Every credential considered for this request, in the order considered.
   *
   * Recorded on EVERY record, including the trivial single-candidate case.
   * Silent credential substitution is a billing incident: a developer believes
   * their own subscription paid, the org is invoiced instead, and nothing
   * anywhere says so. An always-present list means "which credential paid for
   * this, and what else was tried" is a lookup rather than an investigation.
   */
  readonly credentialsConsidered: readonly CredentialAttempt[];
}
