/**
 * Claude Code's session-start warmup ping, and Anthropic's refusal of it.
 *
 * On every new session Claude Code sends exactly one non-streaming request
 * before anything else: a ~311-byte, `max_tokens: 1`, no-system, no-tools ping.
 * On a Claude subscription bearer Anthropic refuses it. The client shrugs this
 * off and the session proceeds normally on the streaming requests that follow,
 * so nothing is broken — but Fest recorded it as `upstream_error`, which put a
 * failure in the dashboard at the start of every single session and warned
 * about it in the gateway log.
 *
 * Captured directly against `api.anthropic.com` with Fest out of the path
 * (`tools/capture-server.ts`, MODE=forward), so this is Anthropic's behaviour
 * and not something the gateway causes:
 *
 *     POST /v1/messages?beta=true   311 bytes
 *       model: claude-opus-5   stream: false   max_tokens: 1
 *       system_present: false  tool_count: 0   message_count: 1
 *     -> 429  x-should-retry: true   NO anthropic-ratelimit-* headers
 *        {"type":"error","error":{"type":"rate_limit_error","message":"Error"}}
 *
 * The same ping on a server-held org API key returns 200, and the streaming
 * turn 1.7s later on the same subscription bearer returns 200 with the full
 * quota header set reading `allowed` at 0.37 utilization. So it is not a quota
 * rejection; it is a shape rejection wearing a quota status code.
 *
 * WHY THIS IS NOT A BLANKET "IGNORE 429s"
 *
 * The discriminator is the headers. A genuine rate limit arrives with the
 * `anthropic-ratelimit-unified-*` set, which is precisely what Claude Code's
 * own `/status` reads; this refusal arrives with none of them. A developer who
 * really is out of quota still gets a loud, correctly-counted error — which
 * matters, because an error rate that reads as zero during an outage is the
 * failure mode this codebase has already been bitten by once (see
 * `test/stream-status.test.ts`).
 *
 * WHAT IS DELIBERATELY NOT DONE HERE
 *
 * The 429 is still relayed to Claude Code unchanged. Fest reclassifies its own
 * record of what happened; it does not edit what Anthropic said. Rewriting a
 * provider's response into a friendlier one would make the gateway a source of
 * fiction about the provider, which is worth more than a tidy client UI.
 */

import type { RateLimitSnapshot } from "../../shared/types.ts";

export interface PreflightCandidate {
  readonly httpStatus: number;
  /** The request's own `stream` flag, as the client sent it. */
  readonly stream: boolean;
  /** Body `max_tokens`, or null when unparseable. */
  readonly maxTokens: number | null;
  /** Parsed quota headers. Null means the response carried none at all. */
  readonly rateLimit: RateLimitSnapshot | null;
  /** True only for a developer's own subscription bearer. */
  readonly subscription: boolean;
}

/**
 * Four conditions, all required. Each one narrows the predicate past something
 * a real failure could look like:
 *
 *  - `subscription` — the refusal is specific to the OAuth bearer; the same
 *    request on an org key succeeds, so an org key's 429 is always real.
 *  - `!stream` — Claude Code sends exactly one non-streaming request per
 *    session, this one. Every real turn streams.
 *  - `maxTokens === 1` — a ping, not work. No genuine request asks for a token.
 *  - `rateLimit === null` — a real quota 429 carries its headers.
 *
 * Narrow on purpose. If Anthropic changes the ping or starts answering it
 * properly, this stops matching and the row goes back to being a plain
 * `upstream_error` — which is the right direction to fail: visible, not silent.
 */
export function isWarmupPreflightRefusal(c: PreflightCandidate): boolean {
  return (
    c.httpStatus === 429 &&
    c.subscription &&
    !c.stream &&
    c.maxTokens === 1 &&
    c.rateLimit === null
  );
}
