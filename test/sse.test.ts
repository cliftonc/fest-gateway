import { test } from "node:test";
import assert from "node:assert/strict";
import { createSseParser } from "../server/http/sse.ts";
import { createUsageAccumulator } from "../server/usage/accumulator.ts";
import type { SseEvent } from "../shared/types.ts";
import {
  CLAUDE_STREAM,
  CLAUDE_STREAM_CRLF,
  EXPECTED,
  chunksAt,
  encode,
  fixedChunks,
  offsetAfter,
  offsetInsideMultibyte,
} from "./fixtures/claude-stream.ts";

/** Feed pre-split chunks through a parser and collect everything it emits. */
function run(chunks: readonly Uint8Array[]): SseEvent[] {
  const parser = createSseParser();
  const events: SseEvent[] = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.flush());
  return events;
}

function meter(chunks: readonly Uint8Array[]) {
  const accumulator = createUsageAccumulator();
  for (const event of run(chunks)) accumulator.apply(event);
  return accumulator;
}

// ── The important one: identical usage under every possible chunking ──────────

const bytes = encode(CLAUDE_STREAM);

const CHUNKINGS: ReadonlyArray<{ name: string; chunks: Uint8Array[] }> = [
  { name: "one single chunk", chunks: [bytes] },
  { name: "byte by byte", chunks: fixedChunks(bytes, 1) },
  { name: "3-byte chunks", chunks: fixedChunks(bytes, 3) },
  { name: "7-byte chunks", chunks: fixedChunks(bytes, 7) },
  {
    name: "split mid-data-line",
    chunks: chunksAt(bytes, [
      offsetAfter(CLAUDE_STREAM, `data: {"type":"message_start","message":{"id":"msg_01`),
      offsetAfter(CLAUDE_STREAM, `"usage":{"input_tokens":1`),
      offsetAfter(CLAUDE_STREAM, `"usage":{"input_tokens":17,"cache_read_input_tokens":21504,"cache_creation_input_tokens":3584,"output_tokens":4`),
    ]),
  },
  {
    name: "split inside the field name",
    chunks: chunksAt(bytes, [
      offsetAfter(CLAUDE_STREAM, "event: mess"),
      offsetAfter(CLAUDE_STREAM, "event: message_delta\nda"),
    ]),
  },
  {
    name: "split inside a 2-byte code point (é)",
    chunks: chunksAt(bytes, [offsetInsideMultibyte(CLAUDE_STREAM, "é")]),
  },
  {
    name: "split inside a 3-byte code point (→)",
    chunks: chunksAt(bytes, [offsetInsideMultibyte(CLAUDE_STREAM, "→")]),
  },
  {
    name: "split inside a 4-byte code point (🔥)",
    chunks: chunksAt(bytes, [
      offsetInsideMultibyte(CLAUDE_STREAM, "🔥"),
      offsetInsideMultibyte(CLAUDE_STREAM, "🔥") + 2,
      offsetInsideMultibyte(CLAUDE_STREAM, "🔥") + 3,
    ]),
  },
  {
    name: "split between CR and LF",
    chunks: (() => {
      const crlf = encode(CLAUDE_STREAM_CRLF);
      const at = offsetAfter(CLAUDE_STREAM_CRLF, "event: message_start\r");
      return chunksAt(crlf, [at]);
    })(),
  },
  { name: "CRLF framing, one chunk", chunks: [encode(CLAUDE_STREAM_CRLF)] },
  { name: "CRLF framing, byte by byte", chunks: fixedChunks(encode(CLAUDE_STREAM_CRLF), 1) },
];

for (const { name, chunks } of CHUNKINGS) {
  test(`chunking is invisible: ${name}`, () => {
    const accumulator = meter(chunks);
    assert.equal(accumulator.sawUsage(), true);
    assert.deepEqual(accumulator.snapshot(), { ...EXPECTED });
    assert.equal(accumulator.streamError(), null);
  });
}

test("every chunking yields the byte-identical interesting event stream", () => {
  const reference = run([bytes]).map((e) => `${e.type}\u0000${e.data}`);
  // message_start + message_delta, and nothing else.
  assert.equal(reference.length, 2);
  for (const { name, chunks } of CHUNKINGS) {
    if (name.startsWith("CRLF") || name.startsWith("split between")) continue;
    assert.deepEqual(run(chunks).map((e) => `${e.type}\u0000${e.data}`), reference, name);
  }
});

// ── Framing details ──────────────────────────────────────────────────────────

test("filters out uninteresting event types, including ping and content deltas", () => {
  const types = run([bytes]).map((e) => e.type);
  assert.deepEqual(types, ["message_start", "message_delta"]);
});

test("comment lines are ignored and do not split or pollute an event", () => {
  const raw = ": a comment\nevent: message_start\n: another comment\ndata: {\"a\":1}\n\n";
  const events = run([encode(raw)]);
  assert.deepEqual(events, [{ type: "message_start", data: '{"a":1}' }]);
});

test("multiple data lines in one event join with a newline", () => {
  const raw = "event: message_start\ndata: {\"a\":1,\ndata: \"b\":2}\n\n";
  const events = run([encode(raw)]);
  assert.deepEqual(events, [{ type: "message_start", data: '{"a":1,\n"b":2}' }]);
});

test("exactly one leading space after the colon is stripped", () => {
  const events = run([encode("event:message_start\ndata:  two spaces\n\n")]);
  assert.deepEqual(events, [{ type: "message_start", data: " two spaces" }]);
});

test("id and retry fields are ignored but do not leak into the next event", () => {
  const raw = "id: 42\nretry: 3000\nevent: message_start\ndata: {\"a\":1}\n\nid: 43\n\nevent: message_delta\ndata: {\"b\":2}\n\n";
  const events = run([encode(raw)]);
  assert.deepEqual(events, [
    { type: "message_start", data: '{"a":1}' },
    { type: "message_delta", data: '{"b":2}' },
  ]);
});

test("a trailing event with no final blank line is recovered by flush()", () => {
  const parser = createSseParser();
  const mid = parser.push(encode("event: message_delta\ndata: {\"usage\":{\"output_tokens\":9}}"));
  assert.deepEqual(mid, [], "no blank line yet, so nothing is complete");
  const tail = parser.flush();
  assert.deepEqual(tail, [{ type: "message_delta", data: '{"usage":{"output_tokens":9}}' }]);
});

test("flush() on an empty or already-terminated stream emits nothing", () => {
  assert.deepEqual(createSseParser().flush(), []);
  const parser = createSseParser();
  parser.push(encode("event: message_start\ndata: {}\n\n"));
  assert.deepEqual(parser.flush(), []);
});

test("events with no event: field default to type \"message\"", () => {
  const parser = createSseParser({ interestingTypes: new Set(["message"]) });
  const events = [...parser.push(encode("data: hello\n\n")), ...parser.flush()];
  assert.deepEqual(events, [{ type: "message", data: "hello" }]);
});

test("blank lines between events never produce empty events", () => {
  const events = run([encode("\n\n\nevent: message_start\ndata: x\n\n\n\n")]);
  assert.deepEqual(events, [{ type: "message_start", data: "x" }]);
});

test("a custom interestingTypes set overrides the default", () => {
  const parser = createSseParser({ interestingTypes: new Set(["ping"]) });
  const events = [...parser.push(bytes), ...parser.flush()];
  assert.deepEqual(events.map((e) => e.type), ["ping"]);
});

test("the observer never mutates the caller's chunk", () => {
  const chunk = encode(CLAUDE_STREAM);
  const copy = Uint8Array.from(chunk);
  run([chunk]);
  assert.deepEqual(chunk, copy);
});

// ── Bounded memory ───────────────────────────────────────────────────────────

test("a pathologically large single event is dropped, not thrown", () => {
  const parser = createSseParser();
  const huge = "x".repeat(64 * 1024);
  let events: SseEvent[] = [];
  events.push(...parser.push(encode("event: message_start\n")));
  for (let i = 0; i < 24; i++) events.push(...parser.push(encode(`data: ${huge}\n`)));
  events.push(...parser.push(encode("\n")));
  events.push(...parser.flush());
  // The event still arrives (so the stream stays in sync) but the oversized
  // data is not retained.
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "message_start");
  assert.equal(events[0]?.data, "");
  // And the accumulator survives the unparseable payload.
  const accumulator = createUsageAccumulator();
  for (const event of events) accumulator.apply(event);
  assert.equal(accumulator.sawUsage(), false);
});

test("uninteresting events with huge data are not accumulated at all", () => {
  const parser = createSseParser();
  const huge = "y".repeat(256 * 1024);
  for (let i = 0; i < 40; i++) {
    const emitted = parser.push(encode(`event: content_block_delta\ndata: ${huge}\n\n`));
    assert.deepEqual(emitted, []);
  }
  assert.deepEqual(parser.flush(), []);
});
