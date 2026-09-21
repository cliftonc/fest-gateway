/**
 * Error shape and status mapping. `error.message` is rendered verbatim to the
 * developer by Claude Code, and the status decides whether the client retries —
 * a 5xx is retried aggressively (one 501 produced ten retries), so the mapping
 * is load-bearing, not cosmetic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anthropicError,
  statusForErrorType,
  sseErrorEvent,
  type AnthropicErrorType,
} from "../server/http/errors.ts";

test("anthropicError produces the exact Anthropic envelope", () => {
  const body = anthropicError("authentication_error", "Fest: unknown identity token.");
  assert.equal(
    body,
    '{"type":"error","error":{"type":"authentication_error","message":"Fest: unknown identity token."}}',
  );
  const parsed: unknown = JSON.parse(body);
  assert.deepEqual(parsed, {
    type: "error",
    error: { type: "authentication_error", message: "Fest: unknown identity token." },
  });
});

test("messages with quotes and newlines stay valid JSON", () => {
  const body = anthropicError("invalid_request_error", 'bad "model"\nline two');
  const parsed = JSON.parse(body) as { error: { message: string } };
  assert.equal(parsed.error.message, 'bad "model"\nline two');
});

const STATUSES: ReadonlyArray<readonly [AnthropicErrorType, number]> = [
  ["invalid_request_error", 400],
  ["authentication_error", 401],
  ["permission_error", 403],
  ["not_found_error", 404],
  ["rate_limit_error", 429],
  ["api_error", 500],
  ["overloaded_error", 529],
];

for (const [type, status] of STATUSES) {
  test(`statusForErrorType: ${type} -> ${status}`, () => {
    assert.equal(statusForErrorType(type), status);
  });
}

test("only the genuinely transient types are 5xx, because 5xx is retried hard", () => {
  const fivexx = STATUSES.filter(([, s]) => s >= 500).map(([t]) => t);
  assert.deepEqual(fivexx, ["api_error", "overloaded_error"]);
});

test("sseErrorEvent is a well-formed frame ending in a blank line", () => {
  const frame = sseErrorEvent("api_error", "Fest: upstream closed mid-stream.");
  assert.ok(frame.startsWith("event: error\n"));
  assert.ok(frame.endsWith("\n\n"), "an SSE frame must be terminated by a blank line");

  const lines = frame.slice(0, -2).split("\n");
  assert.deepEqual(lines, [
    "event: error",
    `data: ${anthropicError("api_error", "Fest: upstream closed mid-stream.")}`,
  ]);
  // The data line must be a single line, or the frame would be truncated there.
  const data = lines[1]!.slice("data: ".length);
  assert.deepEqual(JSON.parse(data), {
    type: "error",
    error: { type: "api_error", message: "Fest: upstream closed mid-stream." },
  });
});
