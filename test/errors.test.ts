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
  describeUpstreamFailure,
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

/**
 * Reading an upstream's refusal, which is the inverse of everything above: the
 * shape is the provider's to choose, not ours, and the result must be populated
 * no matter what arrives. A null `error_message` on a failed request is how this
 * gateway used to lose the only field worth having.
 */
test("the standard Anthropic/Fireworks envelope is read as-is", () => {
  const f = describeUpstreamFailure(
    400,
    '{"type":"error","error":{"type":"invalid_request_error","message":"context_management: Extra inputs are not permitted"}}',
  );
  assert.equal(f.type, "invalid_request_error");
  assert.equal(f.message, "context_management: Extra inputs are not permitted");
});

test("the raw text is preserved for relay, whatever we made of it", () => {
  const raw = '{"error":{"message":"nope"}}';
  assert.equal(describeUpstreamFailure(400, raw).text, raw);
});

test("`code` stands in for a missing `type`, as some providers send only that", () => {
  const f = describeUpstreamFailure(400, '{"error":{"code":"invalid_body","message":"bad field"}}');
  assert.equal(f.type, "invalid_body");
  assert.equal(f.message, "bad field");
});

test("a flattened envelope is read too", () => {
  const f = describeUpstreamFailure(404, '{"message":"model not found"}');
  assert.equal(f.message, "model not found");
  assert.equal(f.type, "not_found_error", "no type in the body, so the status supplies one");
});

test("a bare string error is a message", () => {
  assert.equal(describeUpstreamFailure(400, '{"error":"model is required"}').message, "model is required");
});

test("a body that is not JSON becomes the message rather than nothing", () => {
  const f = describeUpstreamFailure(502, "<html><body>Bad Gateway</body></html>");
  assert.equal(f.type, "api_error");
  assert.match(f.message, /Bad Gateway/);
});

test("the type is never null, because a row that knows only its status explains nothing", () => {
  for (const status of [400, 401, 403, 404, 429, 500, 529]) {
    const f = describeUpstreamFailure(status, "");
    assert.notEqual(f.type, "");
    assert.equal(typeof f.type, "string");
  }
  assert.equal(describeUpstreamFailure(429, "").type, "rate_limit_error");
  assert.equal(describeUpstreamFailure(401, "").type, "authentication_error");
});

test("a message is truncated but generously — the field path can be well into it", () => {
  const long = "x".repeat(5000);
  const f = describeUpstreamFailure(400, JSON.stringify({ error: { message: long } }));
  assert.equal(f.message.length, 500);
  assert.equal(f.text.length, JSON.stringify({ error: { message: long } }).length, "relay is not truncated");
});

/**
 * A provider that echoes the offending request back can echo a credential with
 * it. This string is persisted, so redaction happens on the way in — the log
 * redactor never sees it.
 */
test("a credential echoed back in an error body is redacted before it is stored", () => {
  const f = describeUpstreamFailure(
    400,
    JSON.stringify({ error: { message: "rejected header authorization: Bearer sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789" } }),
  );
  assert.doesNotMatch(f.message, /sk-ant-oat01-abcdefghijklmnopqrstuvwxyz/);
  assert.match(f.message, /<redacted>/);
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
