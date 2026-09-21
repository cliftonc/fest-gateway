/**
 * Folds Anthropic SSE events into a single UsagePayload.
 *
 * The whole point of this module is one rule, so it is stated up front:
 *
 *   USAGE FIELDS ARE LAST-WINS. THEY ARE NEVER SUMMED.
 *
 * `message_delta.usage.output_tokens` is the FINAL CUMULATIVE count for the
 * message, re-sent (and revised upward) on each delta. Adding deltas together
 * over-counts output by roughly the number of deltas — the classic 10x
 * over-billing bug. If you are here because totals look low, the fix is
 * somewhere else; do not turn these assignments into `+=`.
 *
 * Secondly, this code runs on a proxied request that has already been answered.
 * `apply()` must never throw, whatever the upstream sends: malformed JSON, a
 * JSON `null`, a string where a number belongs, NaN, Infinity, negatives.
 * Anything unusable is treated as *absent*, which leaves the previous value in
 * place.
 */

import { EMPTY_USAGE, type SseEvent, type UsagePayload } from "../../shared/types.ts";

export interface UsageAccumulator {
  apply(event: SseEvent): void;
  /** Current best-known usage. */
  snapshot(): UsagePayload;
  /** Whether any usage was ever observed (distinguishes "0 tokens" from "never saw usage"). */
  sawUsage(): boolean;
  /** The error surfaced by an SSE `error` event, if any. */
  streamError(): { type: string; message: string } | null;
}

/** Mutable mirror of UsagePayload, which is deliberately readonly. */
interface Draft {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  webSearches: number;
  serviceTier: string | undefined;
  /**
   * True once a nested `cache_creation` breakdown has been merged. Needed
   * because `message_delta` re-echoes the *flat* `cache_creation_input_tokens`
   * without the breakdown, and naively applying the flat-to-5m approximation
   * then would move the 1h tokens into 5m while leaving 1h set — inflating the
   * cache-write total. Precise data, once seen, always wins.
   */
  cacheBreakdownKnown: boolean;
}

/**
 * Accept only a real, finite, non-negative number.
 *
 * Numeric strings are rejected rather than coerced on purpose: a `"1234"` from
 * Anthropic would mean the wire format changed, and silently accepting it would
 * hide that. `Number("")` is 0 and `Number("abc")` is NaN, so string coercion
 * also turns junk into plausible-looking zeroes.
 */
function num(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) return undefined; // NaN, Infinity, -Infinity
  if (value < 0) return undefined;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  // typeof null === "object", and arrays are objects too. Neither is a usage
  // block, and treating them as one yields undefined lookups rather than throws.
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Merge one `usage` object into a draft, last-wins per field.
 * Returns true if at least one field was usable — that, not the mere presence
 * of a `usage` key, is what "we observed usage" means.
 */
function mergeUsage(draft: Draft, usage: Record<string, unknown>): boolean {
  let seen = false;

  const input = num(usage["input_tokens"]);
  if (input !== undefined) {
    // Never add cache reads in here. The buckets are disjoint billing buckets;
    // see the UsagePayload doc comment in shared/types.ts.
    draft.inputTokens = input;
    seen = true;
  }

  const cacheRead = num(usage["cache_read_input_tokens"]);
  if (cacheRead !== undefined) {
    draft.cacheReadTokens = cacheRead;
    seen = true;
  }

  // Cache writes: prefer the per-TTL breakdown when Anthropic sends it.
  const creation = asRecord(usage["cache_creation"]);
  const fiveM = creation ? num(creation["ephemeral_5m_input_tokens"]) : undefined;
  const oneH = creation ? num(creation["ephemeral_1h_input_tokens"]) : undefined;
  if (fiveM !== undefined || oneH !== undefined) {
    if (fiveM !== undefined) draft.cacheWrite5mTokens = fiveM;
    if (oneH !== undefined) draft.cacheWrite1hTokens = oneH;
    draft.cacheBreakdownKnown = true;
    seen = true;
  } else {
    const flat = num(usage["cache_creation_input_tokens"]);
    if (flat !== undefined && draft.cacheBreakdownKnown) {
      // We already have the real per-TTL split from an earlier event; the flat
      // total is the same tokens, just less precisely reported. Count it as
      // observed but do not overwrite.
      seen = true;
    } else if (flat !== undefined) {
      // APPROXIMATION, and only when the breakdown is absent: the flat total is
      // attributed entirely to the 5m bucket because 5m is the default TTL and
      // the overwhelmingly common case. If `cache_creation` is present it always
      // wins, so this never overrides real per-TTL data. 1h is left untouched
      // rather than zeroed, to stay last-wins-per-field.
      draft.cacheWrite5mTokens = flat;
      seen = true;
    }
  }

  const output = num(usage["output_tokens"]);
  if (output !== undefined) {
    // Assignment, not accumulation. See the module header.
    draft.outputTokens = output;
    seen = true;
  }

  const tier = usage["service_tier"];
  if (typeof tier === "string" && tier.length > 0) {
    draft.serviceTier = tier;
    seen = true;
  }

  const toolUse = asRecord(usage["server_tool_use"]);
  if (toolUse) {
    const searches = num(toolUse["web_search_requests"]);
    if (searches !== undefined) {
      draft.webSearches = searches;
      seen = true;
    }
  }

  return seen;
}

function parse(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    // Truncated or hostile payload. Metering loses one event; the request is
    // already served.
    return undefined;
  }
}

export function createUsageAccumulator(): UsageAccumulator {
  const draft: Draft = { ...EMPTY_USAGE, serviceTier: undefined, cacheBreakdownKnown: false };
  let observed = false;
  let error: { type: string; message: string } | null = null;

  return {
    apply(event: SseEvent): void {
      const parsed = parse(event.data);
      const root = asRecord(parsed);
      if (!root) return;

      if (event.type === "message_start") {
        // Usage lives one level deeper here, under the partial message.
        const message = asRecord(root["message"]);
        const usage = message ? asRecord(message["usage"]) : undefined;
        if (usage && mergeUsage(draft, usage)) observed = true;
        return;
      }

      if (event.type === "message_delta") {
        // Older API versions send only output_tokens; newer ones re-echo the
        // input and cache fields. Both go through the same last-wins merge, so
        // a re-echo is a no-op rather than a double count.
        const usage = asRecord(root["usage"]);
        if (usage && mergeUsage(draft, usage)) observed = true;
        return;
      }

      if (event.type === "error") {
        const err = asRecord(root["error"]);
        if (err) {
          const type = typeof err["type"] === "string" ? (err["type"] as string) : "unknown";
          const message = typeof err["message"] === "string" ? (err["message"] as string) : "";
          error = { type, message };
        }
        return;
      }

      // Any other event type carries no usage. Nothing to do.
    },

    snapshot(): UsagePayload {
      return {
        inputTokens: draft.inputTokens,
        cacheReadTokens: draft.cacheReadTokens,
        cacheWrite5mTokens: draft.cacheWrite5mTokens,
        cacheWrite1hTokens: draft.cacheWrite1hTokens,
        outputTokens: draft.outputTokens,
        webSearches: draft.webSearches,
        serviceTier: draft.serviceTier,
      };
    },

    sawUsage(): boolean {
      return observed;
    },

    streamError(): { type: string; message: string } | null {
      return error;
    },
  };
}

/**
 * Parse usage out of a non-streaming JSON response body.
 *
 * Returns null when there is nothing usable, so a caller can tell "no usage
 * reported" from "usage reported as zero" — the same distinction `sawUsage()`
 * draws on the streaming path.
 */
export function usageFromJson(body: unknown): UsagePayload | null {
  const root = asRecord(body);
  if (!root) return null;
  const usage = asRecord(root["usage"]);
  if (!usage) return null;

  const draft: Draft = { ...EMPTY_USAGE, serviceTier: undefined, cacheBreakdownKnown: false };
  if (!mergeUsage(draft, usage)) return null;

  return {
    inputTokens: draft.inputTokens,
    cacheReadTokens: draft.cacheReadTokens,
    cacheWrite5mTokens: draft.cacheWrite5mTokens,
    cacheWrite1hTokens: draft.cacheWrite1hTokens,
    outputTokens: draft.outputTokens,
    webSearches: draft.webSearches,
    serviceTier: draft.serviceTier,
  };
}
