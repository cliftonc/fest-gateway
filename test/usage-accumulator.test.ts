import { test } from "node:test";
import assert from "node:assert/strict";
import { createSseParser } from "../server/http/sse.ts";
import { createUsageAccumulator, usageFromJson } from "../server/usage/accumulator.ts";
import { contextTokens } from "../shared/types.ts";
import { CLAUDE_STREAM, EXPECTED, encode } from "./fixtures/claude-stream.ts";

/** Convenience: apply a list of [type, data] pairs. */
function fold(events: ReadonlyArray<readonly [string, string]>) {
  const accumulator = createUsageAccumulator();
  for (const [type, data] of events) accumulator.apply({ type, data });
  return accumulator;
}

function messageStart(usage: unknown): readonly [string, string] {
  return ["message_start", JSON.stringify({ type: "message_start", message: { usage } })];
}

function messageDelta(usage: unknown): readonly [string, string] {
  return ["message_delta", JSON.stringify({ type: "message_delta", usage })];
}

// ── The whole-stream path ────────────────────────────────────────────────────

test("folds the realistic fixture into the expected usage", () => {
  const parser = createSseParser();
  const accumulator = createUsageAccumulator();
  for (const event of [...parser.push(encode(CLAUDE_STREAM)), ...parser.flush()]) {
    accumulator.apply(event);
  }
  assert.deepEqual(accumulator.snapshot(), { ...EXPECTED });
});

// ── Last-wins, never sum ────────────────────────────────────────────────────

test("message_delta output_tokens OVERWRITES and is never summed", () => {
  // Three deltas, each carrying the cumulative total. Summation would give
  // 100 + 250 + 431 = 781; the correct answer is the last value, 431. If
  // someone "fixes" the accumulator to use +=, this test is the tripwire.
  const accumulator = fold([
    messageStart({ input_tokens: 10, output_tokens: 1 }),
    messageDelta({ output_tokens: 100 }),
    messageDelta({ output_tokens: 250 }),
    messageDelta({ output_tokens: 431 }),
  ]);
  assert.equal(accumulator.snapshot().outputTokens, 431);
  assert.notEqual(accumulator.snapshot().outputTokens, 781);
});

test("a delta reporting FEWER output tokens still wins (last-wins, not max)", () => {
  const accumulator = fold([messageDelta({ output_tokens: 500 }), messageDelta({ output_tokens: 12 })]);
  assert.equal(accumulator.snapshot().outputTokens, 12);
});

test("input and cache fields re-echoed on message_delta are merged, not doubled", () => {
  const accumulator = fold([
    messageStart({ input_tokens: 17, cache_read_input_tokens: 21504, output_tokens: 2 }),
    messageDelta({ input_tokens: 17, cache_read_input_tokens: 21504, output_tokens: 431 }),
  ]);
  assert.deepEqual(accumulator.snapshot(), {
    inputTokens: 17,
    cacheReadTokens: 21504,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 431,
    webSearches: 0,
    serviceTier: undefined,
  });
});

test("missing fields keep the previous value", () => {
  const accumulator = fold([
    messageStart({
      input_tokens: 17,
      cache_read_input_tokens: 999,
      service_tier: "priority",
      output_tokens: 1,
    }),
    // A minimal delta: only output_tokens. Everything else must survive.
    messageDelta({ output_tokens: 88 }),
  ]);
  const usage = accumulator.snapshot();
  assert.equal(usage.inputTokens, 17);
  assert.equal(usage.cacheReadTokens, 999);
  assert.equal(usage.serviceTier, "priority");
  assert.equal(usage.outputTokens, 88);
});

// ── Bucket disjointness and cache_creation shapes ───────────────────────────

test("cache reads are never folded into inputTokens; buckets stay disjoint", () => {
  const usage = fold([
    messageStart({
      input_tokens: 17,
      cache_read_input_tokens: 21504,
      cache_creation: { ephemeral_5m_input_tokens: 3072, ephemeral_1h_input_tokens: 512 },
      output_tokens: 5,
    }),
  ]).snapshot();
  assert.equal(usage.inputTokens, 17, "input must exclude cache reads and writes");
  assert.equal(usage.cacheReadTokens, 21504);
  assert.equal(usage.cacheWrite5mTokens, 3072);
  assert.equal(usage.cacheWrite1hTokens, 512);
  // Context is the sum of the four disjoint buckets.
  assert.equal(contextTokens(usage), 17 + 21504 + 3072 + 512);
});

test("nested cache_creation wins over the flat total when both are present", () => {
  const usage = fold([
    messageStart({
      cache_creation_input_tokens: 3584,
      cache_creation: { ephemeral_5m_input_tokens: 3072, ephemeral_1h_input_tokens: 512 },
    }),
  ]).snapshot();
  assert.equal(usage.cacheWrite5mTokens, 3072);
  assert.equal(usage.cacheWrite1hTokens, 512);
});

test("a flat-only cache_creation_input_tokens is attributed to the 5m bucket", () => {
  const usage = fold([messageStart({ cache_creation_input_tokens: 3584 })]).snapshot();
  assert.equal(usage.cacheWrite5mTokens, 3584);
  assert.equal(usage.cacheWrite1hTokens, 0);
});

test("a later flat total never clobbers an already-known 5m/1h breakdown", () => {
  // Exactly the real Claude Code shape: message_start has the breakdown, the
  // delta re-echoes only the flat sum. Applying the flat-to-5m approximation
  // here would report 3584 + 512 = 4096 cache-write tokens for 3584 real ones.
  const usage = fold([
    messageStart({ cache_creation: { ephemeral_5m_input_tokens: 3072, ephemeral_1h_input_tokens: 512 } }),
    messageDelta({ cache_creation_input_tokens: 3584, output_tokens: 431 }),
  ]).snapshot();
  assert.equal(usage.cacheWrite5mTokens, 3072);
  assert.equal(usage.cacheWrite1hTokens, 512);
  assert.equal(usage.cacheWrite5mTokens + usage.cacheWrite1hTokens, 3584);
});

test("a partial cache_creation breakdown leaves the other bucket alone", () => {
  const usage = fold([
    messageStart({ cache_creation: { ephemeral_1h_input_tokens: 64 } }),
  ]).snapshot();
  assert.equal(usage.cacheWrite1hTokens, 64);
  assert.equal(usage.cacheWrite5mTokens, 0);
});

test("web search requests and service tier are captured", () => {
  const usage = fold([
    messageStart({ service_tier: "standard", server_tool_use: { web_search_requests: 3 } }),
  ]).snapshot();
  assert.equal(usage.webSearches, 3);
  assert.equal(usage.serviceTier, "standard");
});

// ── sawUsage ────────────────────────────────────────────────────────────────

test("sawUsage distinguishes a genuine zero from never having seen usage", () => {
  assert.equal(createUsageAccumulator().sawUsage(), false);

  const zero = fold([messageStart({ input_tokens: 0, output_tokens: 0 })]);
  assert.equal(zero.sawUsage(), true, "a reported zero IS an observation");
  assert.equal(zero.snapshot().inputTokens, 0);

  // Content deltas alone tell us nothing about usage.
  const deltasOnly = fold([
    ["content_block_delta", '{"delta":{"text":"hi"}}'],
    ["message_stop", '{"type":"message_stop"}'],
  ]);
  assert.equal(deltasOnly.sawUsage(), false);
});

test("a usage object with nothing usable in it does not count as observed", () => {
  assert.equal(fold([messageStart({})]).sawUsage(), false);
  assert.equal(fold([messageStart({ input_tokens: "17" })]).sawUsage(), false);
  assert.equal(fold([messageDelta({ output_tokens: null })]).sawUsage(), false);
});

// ── Hostile and malformed payloads ──────────────────────────────────────────

const HOSTILE: ReadonlyArray<readonly [string, string]> = [
  ["message_start", "{not json at all"],
  ["message_start", ""],
  ["message_start", "null"],
  ["message_start", "[]"],
  ["message_start", "42"],
  ["message_start", '"a string"'],
  ["message_start", "{}"],
  ["message_start", '{"message":null}'],
  ["message_start", '{"message":{"usage":null}}'],
  ["message_start", '{"message":{"usage":[]}}'],
  ["message_start", '{"message":{"usage":{"input_tokens":"123"}}}'],
  ["message_start", '{"message":{"usage":{"input_tokens":-5}}}'],
  ["message_start", '{"message":{"usage":{"input_tokens":1e999}}}'],
  ["message_start", '{"message":{"usage":{"cache_creation":"nope"}}}'],
  ["message_start", '{"message":{"usage":{"server_tool_use":7}}}'],
  ["message_start", '{"message":{"usage":{"service_tier":123}}}'],
  ["message_delta", '{"usage":{"output_tokens":true}}'],
  ["message_delta", "{}"],
  ["message_delta", '{"usage":{}}'],
  ["error", "{}"],
  ["error", '{"error":null}'],
  ["unknown_event_type", '{"whatever":1}'],
];

test("apply() never throws on malformed or hostile payloads", () => {
  for (const [type, data] of HOSTILE) {
    const accumulator = createUsageAccumulator();
    assert.doesNotThrow(() => accumulator.apply({ type, data }), `${type}: ${data}`);
    assert.equal(accumulator.sawUsage(), false, `${type}: ${data}`);
    assert.deepEqual(accumulator.snapshot(), {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 0,
      webSearches: 0,
      serviceTier: undefined,
    });
  }
});

test("NaN, Infinity, negatives and strings are treated as absent, not as zero", () => {
  const accumulator = fold([
    messageStart({ input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 5 }),
    // JSON has no NaN/Infinity literals, so these arrive as the strings a
    // sloppy serialiser would emit, plus the numeric forms a JS caller could
    // hand us directly.
    ["message_delta", '{"usage":{"input_tokens":"NaN","cache_read_input_tokens":-1,"output_tokens":9}}'],
  ]);
  const usage = accumulator.snapshot();
  assert.equal(usage.inputTokens, 100, "garbage must not zero a known value");
  assert.equal(usage.cacheReadTokens, 200, "a negative must not zero a known value");
  assert.equal(usage.outputTokens, 9);
});

test("non-finite numbers arriving through a direct object are rejected", () => {
  // JSON.parse cannot produce these, but usageFromJson takes `unknown` from
  // callers who may have built the object themselves.
  assert.equal(usageFromJson({ usage: { input_tokens: Number.NaN } }), null);
  assert.equal(usageFromJson({ usage: { input_tokens: Number.POSITIVE_INFINITY } }), null);
  assert.equal(usageFromJson({ usage: { input_tokens: -1 } }), null);
});

test("a hostile stream still yields the usage it did report", () => {
  const accumulator = fold([
    messageStart({ input_tokens: 17, output_tokens: 1 }),
    ["message_delta", "{broken"],
    messageDelta({ output_tokens: 431 }),
  ]);
  assert.equal(accumulator.snapshot().inputTokens, 17);
  assert.equal(accumulator.snapshot().outputTokens, 431);
  assert.equal(accumulator.sawUsage(), true);
});

// ── Stream errors ───────────────────────────────────────────────────────────

test("error events are surfaced via streamError()", () => {
  const accumulator = fold([
    messageStart({ input_tokens: 17, output_tokens: 1 }),
    ["error", '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'],
  ]);
  assert.deepEqual(accumulator.streamError(), { type: "overloaded_error", message: "Overloaded" });
  // Usage observed before the error is still reported: the request really did
  // consume those tokens.
  assert.equal(accumulator.snapshot().inputTokens, 17);
});

test("an error with missing fields is still captured with safe defaults", () => {
  const accumulator = fold([["error", '{"error":{}}']]);
  assert.deepEqual(accumulator.streamError(), { type: "unknown", message: "" });
});

test("streamError() is null on a clean stream", () => {
  assert.equal(fold([messageDelta({ output_tokens: 1 })]).streamError(), null);
});

// ── usageFromJson ───────────────────────────────────────────────────────────

test("usageFromJson reads the non-streaming response shape", () => {
  const usage = usageFromJson({
    id: "msg_01",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 17,
      cache_read_input_tokens: 21504,
      cache_creation_input_tokens: 3584,
      cache_creation: { ephemeral_5m_input_tokens: 3072, ephemeral_1h_input_tokens: 512 },
      output_tokens: 431,
      service_tier: "standard",
      server_tool_use: { web_search_requests: 1 },
    },
  });
  assert.deepEqual(usage, { ...EXPECTED });
});

test("usageFromJson returns null when usage is absent or unusable", () => {
  assert.equal(usageFromJson(null), null);
  assert.equal(usageFromJson(undefined), null);
  assert.equal(usageFromJson("string"), null);
  assert.equal(usageFromJson(7), null);
  assert.equal(usageFromJson([]), null);
  assert.equal(usageFromJson({}), null);
  assert.equal(usageFromJson({ usage: null }), null);
  assert.equal(usageFromJson({ usage: "nope" }), null);
  assert.equal(usageFromJson({ usage: {} }), null);
  assert.equal(usageFromJson({ usage: { input_tokens: "17" } }), null);
});

test("usageFromJson reports a genuine zero rather than null", () => {
  assert.deepEqual(usageFromJson({ usage: { input_tokens: 0, output_tokens: 0 } }), {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 0,
    webSearches: 0,
    serviceTier: undefined,
  });
});

test("snapshot() returns an independent object each call", () => {
  const accumulator = fold([messageStart({ input_tokens: 5 })]);
  const first = accumulator.snapshot();
  const [type, data] = messageDelta({ output_tokens: 9 });
  accumulator.apply({ type, data });
  assert.equal(first.outputTokens, 0, "an earlier snapshot must not change");
  assert.equal(accumulator.snapshot().outputTokens, 9);
});
