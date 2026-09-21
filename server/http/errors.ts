/**
 * Anthropic-shaped error responses.
 *
 * Fest's errors are rendered by a client it does not control, so the wire shape
 * matters twice over: Claude Code parses `error.type` to decide whether to
 * retry, and prints `error.message` verbatim to the developer. That message IS
 * the user-facing UI — write it as something a developer can act on ("Fest: no
 * identity token; set ANTHROPIC_BASE_URL to your /t/<token> URL"), not as an
 * internal condition.
 */

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

/** The exact envelope Anthropic uses, so the client's own parser accepts it. */
export function anthropicError(type: AnthropicErrorType, message: string): string {
  return JSON.stringify({ type: "error", error: { type, message } });
}

/**
 * Map an error type to its HTTP status.
 *
 * Learned the hard way: Claude Code retries 5xx aggressively — a single 501
 * produced ten retries of one request, i.e. ten times the upstream load and a
 * developer watching a hang. Any condition that will NOT improve on retry
 * (missing/unknown identity token, unroutable model, malformed body) must be
 * given a 4xx type. Reserve `api_error`/`overloaded_error` for genuinely
 * transient failures where a retry is the correct client behaviour.
 */
export function statusForErrorType(type: AnthropicErrorType): number {
  switch (type) {
    case "invalid_request_error":
      return 400;
    case "authentication_error":
      return 401;
    case "permission_error":
      return 403;
    case "not_found_error":
      return 404;
    case "rate_limit_error":
      return 429;
    case "api_error":
      return 500;
    case "overloaded_error":
      return 529;
  }
}

/**
 * A complete SSE `error` frame, terminated by the blank line.
 *
 * Used when an upstream dies mid-stream: the status line and headers are long
 * gone, so the only way left to tell the client anything is an in-band error
 * event. Note there is no status to choose here, which is another reason to
 * fail fast with a 4xx before the first byte whenever that is possible.
 */
export function sseErrorEvent(type: AnthropicErrorType, message: string): string {
  return `event: error\ndata: ${anthropicError(type, message)}\n\n`;
}
