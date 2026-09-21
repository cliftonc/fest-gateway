/**
 * Shared test fixture: a realistic Claude Code streaming response, plus the
 * chunking helpers both test files use.
 *
 * The text deliberately contains "é" (2-byte), "→" (3-byte) and "🔥" (4-byte)
 * UTF-8 so that byte-level re-chunking is guaranteed to split code points.
 */

/** Expected usage for CLAUDE_STREAM, per the last-wins rule. */
export const EXPECTED = {
  inputTokens: 17,
  cacheReadTokens: 21504,
  cacheWrite5mTokens: 3072,
  cacheWrite1hTokens: 512,
  outputTokens: 431,
  webSearches: 1,
  serviceTier: "standard",
} as const;

const EVENTS: string[] = [
  `event: message_start
data: {"type":"message_start","message":{"id":"msg_01ABC","type":"message","role":"assistant","model":"claude-sonnet-4-5-20250929","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":17,"cache_read_input_tokens":21504,"cache_creation_input_tokens":3584,"cache_creation":{"ephemeral_5m_input_tokens":3072,"ephemeral_1h_input_tokens":512},"output_tokens":3,"service_tier":"standard","server_tool_use":{"web_search_requests":1}}}}`,

  `event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,

  `: keep-alive comment injected by an intermediary`,

  `event: ping
data: {"type":"ping"}`,

  `event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Café résumé "}}`,

  `event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"→ pointing at 🔥 fire"}}`,

  `event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" — and a naïve tail."}}`,

  `event: content_block_stop
data: {"type":"content_block_stop","index":0}`,

  // The delta carries the FINAL cumulative output_tokens and re-echoes the
  // input/cache fields, exactly as newer API versions do.
  `event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":17,"cache_read_input_tokens":21504,"cache_creation_input_tokens":3584,"output_tokens":431}}`,

  `event: message_stop
data: {"type":"message_stop"}`,
];

/** The fixture as bytes would arrive on the wire: LF framing, blank-line separated. */
export const CLAUDE_STREAM: string = EVENTS.map((e) => `${e}\n\n`).join("");

/** Same stream with CRLF framing, which some intermediaries produce. */
export const CLAUDE_STREAM_CRLF: string = CLAUDE_STREAM.replace(/\n/g, "\r\n");

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Split bytes into fixed-size chunks (size 1 = the byte-by-byte torture test). */
export function fixedChunks(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

/** Split bytes at explicit offsets, for deliberately nasty boundaries. */
export function chunksAt(bytes: Uint8Array, offsets: readonly number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let prev = 0;
  for (const offset of offsets) {
    const at = Math.max(0, Math.min(bytes.length, offset));
    if (at > prev) out.push(bytes.subarray(prev, at));
    prev = at;
  }
  if (prev < bytes.length) out.push(bytes.subarray(prev));
  return out;
}

/** Byte offset just after the first occurrence of `needle`. */
export function offsetAfter(text: string, needle: string): number {
  const index = text.indexOf(needle);
  if (index === -1) throw new Error(`fixture missing ${JSON.stringify(needle)}`);
  return new TextEncoder().encode(text.slice(0, index + needle.length)).length;
}

/** Offset landing in the middle of the first multi-byte code point in `text`. */
export function offsetInsideMultibyte(text: string, char: string): number {
  const index = text.indexOf(char);
  if (index === -1) throw new Error(`fixture missing ${JSON.stringify(char)}`);
  const before = new TextEncoder().encode(text.slice(0, index)).length;
  return before + 1; // one byte into a 2-, 3- or 4-byte sequence
}
