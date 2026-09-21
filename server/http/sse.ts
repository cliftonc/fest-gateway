/**
 * Incremental server-sent-event parser for the proxy's observation path.
 *
 * This parser is a *passive observer*. Upstream bytes are written to the client
 * before they are ever handed here, so nothing in this file may mutate a chunk,
 * throw on malformed input, or retain more than the event currently being
 * assembled. A metering bug must never be able to damage a proxied request.
 *
 * Two independent kinds of chunk boundary have to survive, and both have caused
 * real flaky metering:
 *
 *  1. A boundary mid-line — `data: {"usa` / `ge":{...}}\n\n`. Handled by the
 *     `pending` line remainder.
 *  2. A boundary mid-UTF-8-code-point — a 3-byte `→` arriving as 2 bytes then
 *     1 byte. Handled by a *persistent* StringDecoder, which holds the partial
 *     code point across calls. Do not replace it with `Buffer.toString("utf8")`
 *     or `TextDecoder` without `{ stream: true }`: both would emit U+FFFD at
 *     the split and silently corrupt the JSON that follows.
 */

import { StringDecoder } from "node:string_decoder";
import { USAGE_EVENT_TYPES, type SseEvent } from "../../shared/types.ts";

export interface SseParser {
  /** Feed a chunk. Returns events completed by this chunk. */
  push(chunk: Uint8Array): SseEvent[];
  /** Flush any trailing event at stream end. */
  flush(): SseEvent[];
}

/**
 * Cap on the data accumulated for a single event. A well-behaved Anthropic
 * event is a few hundred bytes; anything past this is either a hostile upstream
 * or a stream missing its blank-line separators. We drop the excess rather than
 * throw, because losing usage for one request is strictly better than failing it.
 */
const MAX_EVENT_DATA_CHARS = 1024 * 1024;

const DEFAULT_TYPE = "message";

export function createSseParser(opts?: { interestingTypes?: ReadonlySet<string> }): SseParser {
  const interesting = opts?.interestingTypes ?? USAGE_EVENT_TYPES;
  const decoder = new StringDecoder("utf8");

  /** Tail of the last chunk that did not end on a newline. */
  let pending = "";

  // ── Current event state ──
  let eventType: string | null = null;
  let dataParts: string[] = [];
  let dataChars = 0;
  let sawAnyField = false;
  /**
   * Set once we know this event's type is uninteresting. From that point its
   * `data:` lines are counted but never retained — content deltas are the
   * overwhelming bulk of stream bytes, and joining them would make the observer
   * cost scale with the response body rather than with the usage metadata.
   *
   * Note we cannot decide this before the `event:` line is seen, because an
   * event with no `event:` field defaults to "message". Anthropic always sends
   * `event:` first, so in practice the drop begins before any data is held.
   */
  let dropData = false;

  function resetEvent(): void {
    eventType = null;
    dataParts = [];
    dataChars = 0;
    sawAnyField = false;
    dropData = false;
  }

  function isInteresting(type: string): boolean {
    return interesting.has(type);
  }

  /** Emit the assembled event if it is one we care about, then reset. */
  function dispatch(out: SseEvent[]): void {
    if (!sawAnyField) {
      // A stray blank line between events, or leading whitespace. Not an event.
      resetEvent();
      return;
    }
    const type = eventType ?? DEFAULT_TYPE;
    if (isInteresting(type)) out.push({ type, data: dataParts.join("\n") });
    resetEvent();
  }

  function handleLine(line: string, out: SseEvent[]): void {
    if (line.length === 0) {
      dispatch(out);
      return;
    }
    // ":" prefix is an SSE comment (Anthropic sends none, but proxies inject
    // heartbeat comments). Never treat it as a field.
    if (line.charCodeAt(0) === 58 /* : */) return;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    // Exactly one optional leading space is part of the framing, not the value.
    if (value.charCodeAt(0) === 32) value = value.slice(1);

    if (field === "event") {
      sawAnyField = true;
      eventType = value;
      if (!isInteresting(value)) {
        // Release anything buffered before the type was known.
        dropData = true;
        dataParts = [];
      }
      return;
    }
    if (field === "data") {
      sawAnyField = true;
      if (dropData) return;
      if (dataChars + value.length > MAX_EVENT_DATA_CHARS) {
        // Past the cap we stop retaining. The event is still emitted, and the
        // usage accumulator will reject the truncated JSON on its own.
        dropData = true;
        dataParts = [];
        return;
      }
      dataChars += value.length;
      dataParts.push(value);
      return;
    }
    // `id:` and `retry:` are valid framing we have no use for. Marking the
    // event as "seen" keeps an id-only event from leaking into the next one.
    if (field === "id" || field === "retry") {
      sawAnyField = true;
      return;
    }
    // Unknown field: ignore per the SSE spec.
  }

  function consume(text: string, out: SseEvent[]): void {
    if (text.length === 0) return;
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      if (nl === -1) break;
      let line = pending.length > 0 ? pending + text.slice(start, nl) : text.slice(start, nl);
      pending = "";
      start = nl + 1;
      // Accept CRLF as well as LF. The CR is stripped from the *assembled*
      // line, not from the chunk, because a chunk boundary can fall between
      // the CR and the LF — in which case the CR is the tail of `pending`.
      if (line.charCodeAt(line.length - 1) === 13 /* \r */) line = line.slice(0, -1);
      handleLine(line, out);
    }
    if (start < text.length) pending += text.slice(start);
  }

  return {
    push(chunk: Uint8Array): SseEvent[] {
      const out: SseEvent[] = [];
      // Buffer.from here is a view-free copy of the caller's bytes; we never
      // write through it, so the forwarded chunk cannot be disturbed.
      consume(decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), out);
      return out;
    },

    flush(): SseEvent[] {
      const out: SseEvent[] = [];
      // end() yields any bytes the decoder was holding. An incomplete code
      // point at true end-of-stream becomes U+FFFD, which is correct: the
      // stream really was truncated.
      consume(decoder.end(), out);
      if (pending.length > 0) {
        const line = pending;
        pending = "";
        handleLine(line, out);
      }
      // A stream that ends without its final blank line still produced an event.
      dispatch(out);
      return out;
    },
  };
}
