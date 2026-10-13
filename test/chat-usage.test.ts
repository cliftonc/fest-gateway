import { test } from "node:test";
import assert from "node:assert/strict";
import { createSseParser } from "../server/http/sse.ts";
import { CHAT_USAGE_EVENT_TYPES, chatUsageFromJson, createChatAccumulator } from "../server/usage/chat.ts";

/** A Chat Completions stream as Copilot's API sends it: unnamed events, usage late, then `[DONE]`. */
const STREAM =
  'data: {"choices":[{"delta":{"content":"po"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"ng"}}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":812,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":768}}}\n\n' +
  "data: [DONE]\n\n";

function run(stream: string, chunkSize: number) {
  const parser = createSseParser({ interestingTypes: CHAT_USAGE_EVENT_TYPES });
  const acc = createChatAccumulator();
  const bytes = new TextEncoder().encode(stream);
  for (let i = 0; i < bytes.length; i += chunkSize) {
    for (const e of parser.push(bytes.slice(i, i + chunkSize))) acc.apply(e);
  }
  for (const e of parser.flush()) acc.apply(e);
  return acc;
}

test("usage is read off the late chunk, cached tokens split out of the prompt", () => {
  for (const size of [1, 7, 64, 4096]) {
    const acc = run(STREAM, size);
    const u = acc.snapshot();
    assert.equal(u.inputTokens, 44, `chunk size ${size}`);
    assert.equal(u.cacheReadTokens, 768);
    assert.equal(u.outputTokens, 5);
    assert.equal(acc.sawUsage(), true);
    assert.equal(acc.sawTerminal?.(), true);
  }
});

test("a stream that never asked for usage reports none, honestly", () => {
  const acc = run('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', 16);
  assert.equal(acc.sawUsage(), false);
  assert.equal(acc.snapshot().outputTokens, 0);
  assert.equal(acc.sawTerminal?.(), true);
});

test("a stream cut short has not seen its terminal", () => {
  assert.equal(run('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 16).sawTerminal?.(), false);
});

test("an in-band error chunk is surfaced, and junk never throws", () => {
  const acc = createChatAccumulator();
  acc.apply({ type: "message", data: '{"error":{"type":"rate_limited","message":"slow down"}}' });
  assert.deepEqual(acc.streamError(), { type: "rate_limited", message: "slow down" });
  for (const data of ["", "{", "null", '{"usage":null}', '{"usage":{"prompt_tokens":"12"}}', '{"usage":{"prompt_tokens":-1}}']) {
    acc.apply({ type: "message", data });
  }
  assert.equal(acc.sawUsage(), false);
});

test("a provider reporting more cached than prompt tokens cannot go negative", () => {
  const acc = createChatAccumulator();
  acc.apply({ type: "message", data: '{"usage":{"prompt_tokens":5,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":9}}}' });
  assert.equal(acc.snapshot().inputTokens, 0);
});

test("non-streaming bodies carry the same usage object", () => {
  const u = chatUsageFromJson({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  assert.equal(u?.inputTokens, 10);
  assert.equal(u?.outputTokens, 2);
  assert.equal(chatUsageFromJson({ choices: [] }), null);
});
