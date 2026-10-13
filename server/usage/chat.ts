/**
 * Folds OpenAI Chat Completions SSE chunks into a single UsagePayload.
 *
 * Copilot's own API (`api.<plan>.githubcopilot.com`) serves three wires and
 * picks one per model: Anthropic Messages for Claude, the Responses API for the
 * GPT-5 family and later, and Chat Completions for the rest and for its own
 * utility calls. This is the third. Chunks carry no `event:` field, so every
 * one arrives as the SSE default type, `message`:
 *
 *   data: {"choices":[{"delta":{"content":"po"}}],…}
 *   data: {"choices":[],"usage":{"prompt_tokens":812,"completion_tokens":5,
 *          "prompt_tokens_details":{"cached_tokens":768}},…}
 *   data: [DONE]
 *
 * Usage arrives once, on a late chunk, when the request asked for it
 * (`stream_options.include_usage`); a client that did not ask gets none, and
 * the row honestly records no tokens rather than a guess.
 *
 * ── Mapping onto Fest's disjoint buckets ─────────────────────────────────────
 *
 * Same rule as the Responses API: `prompt_tokens` INCLUDES the cached ones, so
 *
 *   inputTokens     = prompt_tokens − cached_tokens
 *   cacheReadTokens = cached_tokens
 *   outputTokens    = completion_tokens
 *
 * Same contract as the other accumulators: last-wins per field, and `apply()`
 * never throws.
 */

import { EMPTY_USAGE, type SseEvent, type UsagePayload } from "../../shared/types.ts";
import { asRecord, num, parse, type UsageAccumulator } from "./accumulator.ts";

/** Every chunk is a `message`: Chat Completions never names its events. */
export const CHAT_USAGE_EVENT_TYPES: ReadonlySet<string> = new Set(["message"]);

/** Read one Chat Completions `usage` object, or null when nothing in it is usable. */
function fromUsage(usage: Record<string, unknown>): UsagePayload | null {
  const prompt = num(usage["prompt_tokens"]);
  const completion = num(usage["completion_tokens"]);
  if (prompt === undefined && completion === undefined) return null;
  const details = asRecord(usage["prompt_tokens_details"]);
  const cached = (details ? num(details["cached_tokens"]) : undefined) ?? 0;
  return {
    ...EMPTY_USAGE,
    inputTokens: Math.max(0, (prompt ?? 0) - cached),
    cacheReadTokens: cached,
    outputTokens: completion ?? 0,
  };
}

export function createChatAccumulator(): UsageAccumulator {
  let usage: UsagePayload = EMPTY_USAGE;
  let observed = false;
  let error: { type: string; message: string } | null = null;
  let terminal = false;

  return {
    apply(event: SseEvent): void {
      if (event.data === "[DONE]") {
        terminal = true;
        return;
      }
      // Every content delta is a `message` too, so this runs once per token.
      // Parsing only the chunks that could hold usage or an error keeps the
      // observer's cost proportional to the metadata, not to the answer.
      if (!event.data.includes('"usage"') && !event.data.includes('"error"')) return;
      const root = asRecord(parse(event.data));
      if (!root) return;

      const err = asRecord(root["error"]);
      if (err) {
        error = {
          type: typeof err["type"] === "string" ? err["type"] : (typeof err["code"] === "string" ? err["code"] : "error"),
          message: typeof err["message"] === "string" ? err["message"] : "",
        };
        return;
      }

      const u = asRecord(root["usage"]);
      const parsed = u ? fromUsage(u) : null;
      if (parsed !== null) {
        usage = parsed;
        observed = true;
      }
    },

    snapshot: () => usage,
    sawUsage: () => observed,
    streamError: () => error,
    sawTerminal: () => terminal,
  };
}

/** Usage from a non-streaming `POST /chat/completions` body. */
export function chatUsageFromJson(body: unknown): UsagePayload | null {
  const root = asRecord(body);
  const u = root ? asRecord(root["usage"]) : undefined;
  return u ? fromUsage(u) : null;
}
