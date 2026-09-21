/**
 * Header translation between Claude Code and Anthropic.
 *
 * This module is where a subscription pass-through is most easily broken, and
 * the failures are silent: Anthropic validates an OAuth token against the shape
 * of the request that carries it, and Claude Code reports "empty or malformed
 * response" rather than anything actionable. So the rules here are hard
 * requirements, not style preferences, and each one has a comment saying which
 * observed failure it prevents.
 */

import type { Posture, RateLimitSnapshot } from "../../shared/types.ts";
import { HOP_BY_HOP, SECRET_HEADERS } from "../secret/fingerprint.ts";

export interface UpstreamHeaderOptions {
  readonly posture: Posture;
  readonly upstreamHost: string;
  /** Force `accept-encoding: identity` so the SSE stream can be teed. */
  readonly forceIdentityEncoding?: boolean;
}

/** Default when the client omits it entirely. Never an override. */
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/**
 * Headers Fest must never relay upstream regardless of posture.
 *
 * `content-length` is the caller's to set — it rewrites the body framing and a
 * stale value from the inbound request truncates or hangs the upstream POST.
 * `transfer-encoding` is hop-by-hop and undici sets its own.
 */
const NEVER_UPSTREAM: ReadonlySet<string> = new Set(["content-length", "transfer-encoding"]);

/**
 * Build the upstream request headers.
 *
 * ON `posture === "subscription"` EVERYTHING NOT EXPLICITLY DROPPED IS FORWARDED
 * BYTE-FOR-BYTE. Do not "tidy" this:
 *
 *  - Do NOT filter, dedupe, sort or canonicalise `anthropic-beta`. Claude Code
 *    sends 15 comma-separated values (including `oauth-2025-04-20`) and the set
 *    is part of what the OAuth token is validated against.
 *  - Do NOT rewrite `user-agent` (`claude-cli/2.1.278 (external, sdk-cli)`) or
 *    `x-app`, and do NOT drop the `x-stainless-*` telemetry.
 *  - Do NOT inject attribution or telemetry headers of our own — no `x-title`,
 *    no `http-referer`, no `x-fest-*`. Those are OpenRouter-style conventions
 *    and Anthropic rejects the request shape. A future reader will be tempted to
 *    add them "so usage is attributable"; attribution belongs in Fest's own
 *    usage records, not on the wire.
 *
 * `posture` is taken rather than assumed because the key posture is where model
 * routing and rewriting will later be permitted; today both postures forward
 * the same way, which keeps the subscription guarantee the default.
 */
export function buildUpstreamHeaders(
  inbound: Readonly<Record<string, string | string[] | undefined>>,
  opts: UpstreamHeaderOptions,
): Headers {
  const out = new Headers();
  let sawAnthropicVersion = false;

  for (const [name, value] of Object.entries(inbound)) {
    const lower = name.toLowerCase();
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(lower)) continue;
    if (NEVER_UPSTREAM.has(lower)) continue;
    // Fest's identity carriers are ours alone; Anthropic must never see them.
    if (lower.startsWith("x-fest-")) continue;

    const values = Array.isArray(value) ? value : [value];
    for (const one of values) out.append(lower, one);
    if (lower === "anthropic-version") sawAnthropicVersion = true;
  }

  // `host` is hop-by-hop above, so it is re-set here for the real upstream.
  out.set("host", opts.upstreamHost);

  if (!sawAnthropicVersion) out.set("anthropic-version", DEFAULT_ANTHROPIC_VERSION);

  // Metering tees the SSE stream to count tokens; a gzip/zstd-framed body would
  // have to be inflated first, which means buffering a stream whose whole point
  // is not being buffered. Verified against production: asking for `identity`
  // does not change upstream acceptance of a subscription request.
  if (opts.forceIdentityEncoding !== false) out.set("accept-encoding", "identity");

  return out;
}

/**
 * Headers worth relaying back to Claude Code.
 *
 * An allowlist, not a denylist: anything new that appears upstream is more
 * likely to confuse the client (or leak) than to help, and the client reads
 * only these.
 */
const DOWNSTREAM_ALLOW: ReadonlySet<string> = new Set([
  "content-type",
  "request-id",
  "anthropic-request-id",
  "retry-after",
]);

export function buildDownstreamHeaders(
  upstream: Headers,
  opts: { stream: boolean },
): Record<string, string> {
  const out: Record<string, string> = {};

  upstream.forEach((value, name) => {
    const lower = name.toLowerCase();
    // `set-cookie` and friends are in SECRET_HEADERS; never echo a credential.
    if (SECRET_HEADERS.has(lower)) return;
    // We decode/re-frame the body (and tee it), so the upstream's encoding and
    // length no longer describe what the client will actually receive.
    if (lower === "content-encoding" || lower === "content-length") return;
    if (HOP_BY_HOP.has(lower)) return;

    // The quota headers are not diagnostics: Claude Code's own `/status` reads
    // them to show the developer their remaining 5h/7d window. Dropping them
    // makes Fest look like it broke the client's quota display.
    if (lower.startsWith("anthropic-ratelimit-")) {
      out[lower] = value;
      return;
    }
    if (DOWNSTREAM_ALLOW.has(lower)) out[lower] = value;
  });

  // A non-streaming reply served as `text/plain` makes Claude Code report
  // "empty or malformed response" — it content-type-switches before parsing.
  if (out["content-type"] === undefined) out["content-type"] = "application/json";

  if (opts.stream) {
    // Any intermediary that buffers turns a token-by-token stream into one
    // late blob. `no-transform` stops proxies re-compressing; `x-accel-buffering`
    // is nginx's opt-out and is harmless elsewhere.
    out["cache-control"] = "no-cache, no-transform";
    out["x-accel-buffering"] = "no";
    // Length is unknowable for a stream, and setting it truncates the response.
    delete out["content-length"];
  }

  return out;
}

/** Coerce defensively: a malformed upstream value must omit the field, not poison it. */
function num(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function str(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Read Anthropic's unified quota headers into a snapshot.
 *
 * Returns `null` when none are present, so callers can distinguish "upstream
 * said nothing about quota" from "quota is at zero". `exactOptionalPropertyTypes`
 * is on, so absent fields are omitted rather than set to `undefined`.
 */
export function parseRateLimit(upstream: Headers): RateLimitSnapshot | null {
  const status = str(upstream.get("anthropic-ratelimit-unified-status"));
  const fiveHourUtilization = num(upstream.get("anthropic-ratelimit-unified-5h-utilization"));
  const fiveHourStatus = str(upstream.get("anthropic-ratelimit-unified-5h-status"));
  const fiveHourResetAt = num(upstream.get("anthropic-ratelimit-unified-5h-reset"));
  const sevenDayUtilization = num(upstream.get("anthropic-ratelimit-unified-7d-utilization"));
  const sevenDayStatus = str(upstream.get("anthropic-ratelimit-unified-7d-status"));
  const sevenDayResetAt = num(upstream.get("anthropic-ratelimit-unified-7d-reset"));
  const representativeClaim = str(
    upstream.get("anthropic-ratelimit-unified-representative-claim"),
  );
  const overageStatus = str(upstream.get("anthropic-ratelimit-unified-overage-status"));
  const overageDisabledReason = str(
    upstream.get("anthropic-ratelimit-unified-overage-disabled-reason"),
  );

  // Mutable mirror of the readonly snapshot, so fields can be omitted rather
  // than assigned `undefined` (exactOptionalPropertyTypes).
  const snapshot: { -readonly [K in keyof RateLimitSnapshot]?: RateLimitSnapshot[K] } = {};
  if (status !== undefined) snapshot.status = status;
  if (fiveHourUtilization !== undefined) snapshot.fiveHourUtilization = fiveHourUtilization;
  if (fiveHourStatus !== undefined) snapshot.fiveHourStatus = fiveHourStatus;
  if (fiveHourResetAt !== undefined) snapshot.fiveHourResetAt = fiveHourResetAt;
  if (sevenDayUtilization !== undefined) snapshot.sevenDayUtilization = sevenDayUtilization;
  if (sevenDayStatus !== undefined) snapshot.sevenDayStatus = sevenDayStatus;
  if (sevenDayResetAt !== undefined) snapshot.sevenDayResetAt = sevenDayResetAt;
  if (representativeClaim !== undefined) snapshot.representativeClaim = representativeClaim;
  if (overageStatus !== undefined) snapshot.overageStatus = overageStatus;
  if (overageDisabledReason !== undefined) {
    snapshot.overageDisabledReason = overageDisabledReason;
  }

  // Nothing recognised — including the case where every value was garbage.
  if (Object.keys(snapshot).length === 0) return null;
  return snapshot;
}
