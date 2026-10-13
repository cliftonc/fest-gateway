/**
 * Folds OpenAI Responses API SSE events into a single UsagePayload.
 *
 * Codex speaks only this wire (`wire_api = "responses"`), whether it is talking
 * to api.openai.com on a key or to chatgpt.com on a ChatGPT login. Usage arrives
 * once, on the terminal event:
 *
 *   event: response.completed
 *   data: {"type":"response.completed","response":{…,"usage":{
 *     "input_tokens": 15896,
 *     "input_tokens_details": {"cached_tokens": 15616, "cache_write_tokens": 0},
 *     "output_tokens": 7,
 *     "output_tokens_details": {"reasoning_tokens": 0}, …}}}
 *
 * (Shape captured from codex-cli 0.162.1 against chatgpt.com; api.openai.com
 * documents the same object.) `response.created` and `response.in_progress`
 * carry the same response object with `usage: null`, so they are deliberately
 * not parsed — each is ~35KB of echoed instructions and tool schemas.
 *
 * ── Mapping onto Fest's disjoint buckets ─────────────────────────────────────
 *
 * OpenAI's `input_tokens` INCLUDES the cached tokens; Fest's `inputTokens` is
 * the uncached remainder (see `UsagePayload`). So:
 *
 *   inputTokens        = input_tokens − cached_tokens − cache_write_tokens
 *   cacheReadTokens    = cached_tokens
 *   cacheWrite5mTokens = cache_write_tokens
 *   outputTokens       = output_tokens   (reasoning is already inside it)
 *
 * Whether `cache_write_tokens` is inside `input_tokens` is not documented. It
 * is treated as inside — it is an input-side breakdown sitting next to
 * `cached_tokens` in `input_tokens_details` — and the subtraction is clamped at
 * zero, so the worst a wrong guess can do is under-count uncached input by the
 * write count on the rare turn that reports one, never double-count.
 *
 * Same contract as the Anthropic accumulator: last-wins per field, and `apply()`
 * never throws.
 */

import { EMPTY_USAGE, type SseEvent, type UsagePayload } from "../../shared/types.ts";
import { asRecord, num, parse, type UsageAccumulator } from "./accumulator.ts";

/** The events worth parsing. Everything else is forwarded without inspection. */
export const RESPONSES_USAGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "response.completed",
  // A turn cut short by max_output_tokens or a content filter still billed.
  "response.incomplete",
  "response.failed",
  "error",
]);

/**
 * `response.completed` echoes the full response, so it is large: ~36KB for a
 * one-word answer in the capture above, dominated by echoed instructions and a
 * per-item token attribution map that grows with the conversation. Generous,
 * because losing usage to the cap is the failure mode; still bounded, because
 * the observer must not hold an arbitrary amount of memory per request.
 */
export const RESPONSES_MAX_EVENT_CHARS = 32 * 1024 * 1024;

/** Read one Responses `usage` object, or null when nothing in it is usable. */
function fromUsage(usage: Record<string, unknown>): UsagePayload | null {
  const input = num(usage["input_tokens"]);
  const output = num(usage["output_tokens"]);
  const details = asRecord(usage["input_tokens_details"]);
  const cached = (details ? num(details["cached_tokens"]) : undefined) ?? 0;
  const written = (details ? num(details["cache_write_tokens"]) : undefined) ?? 0;
  if (input === undefined && output === undefined) return null;

  return {
    ...EMPTY_USAGE,
    // Never let a provider that reports cached > input produce a negative.
    inputTokens: Math.max(0, (input ?? 0) - cached - written),
    cacheReadTokens: cached,
    cacheWrite5mTokens: written,
    outputTokens: output ?? 0,
    ...(typeof usage["service_tier"] === "string" ? { serviceTier: usage["service_tier"] } : {}),
  };
}

export function createResponsesAccumulator(): UsageAccumulator {
  let usage: UsagePayload = EMPTY_USAGE;
  let observed = false;
  let error: { type: string; message: string } | null = null;
  let terminal = false;

  return {
    apply(event: SseEvent): void {
      const root = asRecord(parse(event.data));
      if (!root) return;

      if (event.type === "error") {
        // `{"type":"error","code":…,"message":…}` — flat, unlike Anthropic's.
        const type = typeof root["code"] === "string" ? root["code"] : "error";
        const message = typeof root["message"] === "string" ? root["message"] : "";
        error = { type, message };
        return;
      }

      const response = asRecord(root["response"]);
      if (!response) return;
      // Every type that reaches here other than `error` is terminal.
      terminal = true;
      const u = asRecord(response["usage"]);
      const parsed = u ? fromUsage(u) : null;
      if (parsed !== null) {
        usage = parsed;
        observed = true;
      }

      if (event.type === "response.failed") {
        const err = asRecord(response["error"]);
        error = {
          type: typeof err?.["code"] === "string" ? (err["code"] as string) : "response_failed",
          message: typeof err?.["message"] === "string" ? (err["message"] as string) : "",
        };
      }
    },

    snapshot: () => usage,
    sawUsage: () => observed,
    streamError: () => error,
    sawTerminal: () => terminal,
  };
}

/** Usage from a non-streaming `POST /responses` body. */
export function responsesUsageFromJson(body: unknown): UsagePayload | null {
  const root = asRecord(body);
  const u = root ? asRecord(root["usage"]) : undefined;
  return u ? fromUsage(u) : null;
}
