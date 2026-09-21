/**
 * Streaming relay with a read-only observation tee.
 *
 * The ordering here is the whole point: bytes go to the client FIRST, then the
 * same buffer is handed to the observer. Metering must never sit between the
 * upstream and the developer's terminal, because first-token latency is the
 * thing people feel.
 *
 * Correspondingly, the observer is never allowed to break a request. It runs
 * inside a try/catch and its failures are counted, not thrown: an accounting
 * record is worth less than a developer's in-flight session.
 */

import type { ServerResponse } from "node:http";
import { once } from "node:events";

export interface PipeResult {
  readonly bytesOut: number;
  /**
   * Time to first byte reaching the client, measured from `startedAt` — which
   * callers should set to when the *request* began, not when piping began. By
   * the time we start piping, `fetch` has already resolved its headers and may
   * have buffered body bytes, so measuring from here reports ~0ms and hides the
   * entire upstream round trip. That number is the one users feel, so getting
   * its origin right matters more than it looks.
   */
  readonly ttfbMs: number | null;
  /** True when the upstream stream ran to completion. */
  readonly completed: boolean;
  /** True when the client went away before the upstream finished. */
  readonly clientAborted: boolean;
  /** Non-zero means some usage may be unrecorded. */
  readonly observerErrors: number;
}

export interface PipeOptions {
  /** Called with every chunk AFTER it has been written to the client. */
  readonly observe: (chunk: Uint8Array) => void;
  /** Aborts the upstream fetch when the client disconnects. */
  readonly abort: AbortController;
  /** Epoch ms the request began, so TTFB covers the upstream round trip. */
  readonly startedAt: number;
}

/**
 * Relay an upstream body to the client, teeing each chunk to `observe`.
 *
 * Backpressure is honoured: if the socket buffer is full we await `drain`
 * rather than queueing indefinitely, otherwise one slow client becomes
 * unbounded memory growth in a shared gateway.
 */
export async function pipeWithTee(
  body: ReadableStream<Uint8Array>,
  res: ServerResponse,
  opts: PipeOptions,
): Promise<PipeResult> {
  const startedAt = opts.startedAt;
  let bytesOut = 0;
  let ttfbMs: number | null = null;
  let observerErrors = 0;
  let clientAborted = false;
  let completed = false;

  // A client that hangs up must not leave the upstream request running: on a
  // subscription that would keep consuming the developer's own quota for output
  // nobody will ever read.
  const onClose = (): void => {
    if (!completed) {
      clientAborted = true;
      opts.abort.abort();
    }
  };
  res.on("close", onClose);

  // The explicit reader API rather than `for await`: Node's web ReadableStream
  // is async-iterable at runtime but not in the DOM type surface, and casting
  // to AsyncIterable to paper over that hides a real difference. The reader also
  // gives us `cancel()`, which is how we release the upstream on client abort.
  const reader = body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || clientAborted) break;
      if (value === undefined) continue;

      if (ttfbMs === null) ttfbMs = Date.now() - startedAt;
      bytesOut += value.byteLength;

      // Client first, always.
      const flushed = res.write(value);
      if (!flushed) await once(res, "drain");

      try {
        opts.observe(value);
      } catch {
        observerErrors += 1;
      }
    }
    completed = !clientAborted;
  } catch (err) {
    // Upstream died mid-stream. Headers are already sent, so the status cannot
    // be changed; the caller decides whether to synthesise a terminal SSE error
    // frame. Never retry here — the client has already rendered partial text.
    if (!clientAborted) throw err;
  } finally {
    res.off("close", onClose);
    // Release the upstream body so an aborted client does not leave us holding
    // a half-read stream (which on a subscription would keep burning the
    // developer's own quota for output nobody will read).
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  return { bytesOut, ttfbMs, completed, clientAborted, observerErrors };
}

/**
 * Prepare a response for streaming.
 *
 * Every line here is defensive against something buffering the stream and
 * destroying perceived latency. `setNoDelay` disables Nagle, which otherwise
 * coalesces small SSE frames and adds tens of milliseconds of jitter per token
 * batch; `x-accel-buffering` and `no-transform` are for intermediaries.
 */
export function beginStream(res: ServerResponse, status: number, headers: Record<string, string>): void {
  res.writeHead(status, headers);
  res.socket?.setNoDelay(true);
  res.flushHeaders();
}
