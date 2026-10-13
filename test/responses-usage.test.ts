import { test } from "node:test";
import assert from "node:assert/strict";
import { createSseParser } from "../server/http/sse.ts";
import {
  createResponsesAccumulator,
  responsesUsageFromJson,
  RESPONSES_MAX_EVENT_CHARS,
  RESPONSES_USAGE_EVENT_TYPES,
} from "../server/usage/responses.ts";
import { CODEX_STREAM, EXPECTED } from "./fixtures/codex-stream.ts";
import { encode, fixedChunks } from "./fixtures/claude-stream.ts";

function foldStream(chunks: readonly Uint8Array[], maxEventChars = RESPONSES_MAX_EVENT_CHARS) {
  const parser = createSseParser({ interestingTypes: RESPONSES_USAGE_EVENT_TYPES, maxEventChars });
  const acc = createResponsesAccumulator();
  for (const chunk of chunks) for (const e of parser.push(chunk)) acc.apply(e);
  for (const e of parser.flush()) acc.apply(e);
  return acc;
}

const completed = (usage: unknown, type = "response.completed") => ({
  type,
  data: JSON.stringify({ type, response: { status: "completed", usage } }),
});

// ── The whole-stream path ────────────────────────────────────────────────────

test("folds a Codex stream into Fest's disjoint buckets", () => {
  const acc = foldStream([encode(CODEX_STREAM)]);
  assert.deepEqual(acc.snapshot(), EXPECTED);
  assert.equal(acc.sawUsage(), true);
  assert.equal(acc.streamError(), null);
});

test("the result does not depend on where the chunks split", () => {
  // Splits land mid-line, mid-JSON and inside the multibyte characters.
  for (const size of [1, 3, 7, 64, 1000]) {
    assert.deepEqual(foldStream(fixedChunks(encode(CODEX_STREAM), size)).snapshot(), EXPECTED, `size ${size}`);
  }
});

test("a response.completed larger than the Anthropic cap still meters", () => {
  // The real event echoes the whole conversation's attribution map; a long
  // session pushes it past the 1MB that is generous for an Anthropic event.
  const big = "x".repeat(2 * 1024 * 1024);
  const stream =
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { instructions: big, usage: { input_tokens: 10, output_tokens: 5 } },
    })}\n\n`;
  assert.equal(foldStream([encode(stream)]).snapshot().outputTokens, 5);
  // And the cap is what makes the difference: at the default it is dropped.
  assert.equal(foldStream([encode(stream)], 1024 * 1024).sawUsage(), false);
});

// ── The mapping ──────────────────────────────────────────────────────────────

test("cached tokens come out of input, never on top of it", () => {
  const acc = createResponsesAccumulator();
  acc.apply(completed({ input_tokens: 1000, input_tokens_details: { cached_tokens: 900 }, output_tokens: 3 }));
  assert.equal(acc.snapshot().inputTokens, 100);
  assert.equal(acc.snapshot().cacheReadTokens, 900);
});

test("a provider reporting more cached than input never yields a negative", () => {
  const acc = createResponsesAccumulator();
  acc.apply(completed({ input_tokens: 10, input_tokens_details: { cached_tokens: 50 }, output_tokens: 1 }));
  assert.equal(acc.snapshot().inputTokens, 0);
});

test("reasoning tokens are already inside output and are not added again", () => {
  const acc = createResponsesAccumulator();
  acc.apply(completed({ input_tokens: 1, output_tokens: 70, output_tokens_details: { reasoning_tokens: 54 } }));
  assert.equal(acc.snapshot().outputTokens, 70);
});

test("an incomplete response still bills what it used", () => {
  const acc = createResponsesAccumulator();
  acc.apply(completed({ input_tokens: 500, output_tokens: 4096 }, "response.incomplete"));
  assert.equal(acc.snapshot().outputTokens, 4096);
  assert.equal(acc.streamError(), null);
});

test("response.failed and error events surface as a stream error", () => {
  const failed = createResponsesAccumulator();
  failed.apply({
    type: "response.failed",
    data: JSON.stringify({
      type: "response.failed",
      response: { status: "failed", error: { code: "server_error", message: "boom" }, usage: null },
    }),
  });
  assert.deepEqual(failed.streamError(), { type: "server_error", message: "boom" });

  const errored = createResponsesAccumulator();
  errored.apply({ type: "error", data: JSON.stringify({ type: "error", code: "rate_limit_exceeded", message: "slow down" }) });
  assert.deepEqual(errored.streamError(), { type: "rate_limit_exceeded", message: "slow down" });
});

test("junk never throws and never invents usage", () => {
  const acc = createResponsesAccumulator();
  for (const data of ["", "not json", "null", "[]", '{"response":null}', '{"response":{"usage":"lots"}}',
    '{"response":{"usage":{"input_tokens":"12","output_tokens":-1}}}']) {
    assert.doesNotThrow(() => acc.apply({ type: "response.completed", data }));
  }
  assert.equal(acc.sawUsage(), false);
});

// ── Non-streaming ────────────────────────────────────────────────────────────

test("a non-streaming response body is read the same way", () => {
  const usage = responsesUsageFromJson({
    id: "resp_1",
    usage: { input_tokens: 300, input_tokens_details: { cached_tokens: 200 }, output_tokens: 9 },
  });
  assert.equal(usage?.inputTokens, 100);
  assert.equal(usage?.cacheReadTokens, 200);
  assert.equal(usage?.outputTokens, 9);
  assert.equal(responsesUsageFromJson({ id: "resp_1" }), null);
});
