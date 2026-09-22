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

import { redactSecrets } from "../secret/fingerprint.ts";

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
 * How much of an upstream's error message to keep.
 *
 * Longer than the 200 chars used for exception strings, deliberately. An
 * exception string is self-describing by its first clause; a provider's
 * validation error is not — the actionable part is a field path that can sit
 * well into the text ("context_management.edits.0: Extra inputs are not
 * permitted"), and a provider may echo a chunk of the offending request before
 * saying what was wrong with it. Truncating to 200 reliably cut the answer off.
 */
const MAX_UPSTREAM_MESSAGE = 500;

/** What a non-2xx upstream response told us, ready to record and to relay. */
export interface UpstreamFailure {
  /** The body, byte-for-byte as received. Relay this; never re-serialise it. */
  readonly text: string;
  readonly type: string;
  readonly message: string;
}

/**
 * Best-effort type for an upstream that sent no parseable error envelope.
 *
 * Derived from the status so `error_type` is never null on a failed request:
 * a row that knows only "400" is barely more useful than no row, and the
 * dashboard already groups by this column.
 */
function typeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 429:
      return "rate_limit_error";
    case 529:
      return "overloaded_error";
    default:
      return status >= 500 ? "api_error" : "invalid_request_error";
  }
}

function firstString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return null;
}

/**
 * Read a failed upstream response into something worth storing.
 *
 * Fest relayed these bodies to the client and recorded nothing but the status,
 * so the one field a developer needs — WHY the provider refused — existed only
 * in their terminal, and only until it scrolled. Every non-2xx landed in the
 * database with `error_type` and `error_message` null.
 *
 * Shapes handled: Anthropic and Fireworks both nest `{ error: { type, message } }`;
 * some gateways flatten it, or send `error` as a bare string, or send no JSON at
 * all. An unparseable body is not a failure to report — the raw text is the
 * message, truncated. The result is always populated.
 */
export function describeUpstreamFailure(status: number, text: string): UpstreamFailure {
  const fallbackType = typeForStatus(status);
  let type: string | null = null;
  let message: string | null = null;

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const top = parsed as Record<string, unknown>;
      const err = top["error"];
      if (typeof err === "object" && err !== null) {
        const e = err as Record<string, unknown>;
        type = firstString(e["type"], e["code"]);
        message = firstString(e["message"], e["detail"]);
      } else {
        message = firstString(err);
      }
      type ??= firstString(top["type"] === "error" ? null : top["type"], top["code"]);
      message ??= firstString(top["message"], top["detail"]);
    }
  } catch {
    // Not JSON. The body itself is the most informative thing we have.
  }

  return {
    text,
    type: type ?? fallbackType,
    // Redacted on the way in, not on the way out: this string is about to be
    // persisted, and an upstream that echoes the offending request back could
    // echo a credential header with it.
    message: redactSecrets(message ?? text).slice(0, MAX_UPSTREAM_MESSAGE),
  };
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
