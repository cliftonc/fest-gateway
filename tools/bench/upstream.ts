/**
 * The fake model API the bench points Fest at: Anthropic-shaped SSE, with a
 * turn shape the bench controls (time to first byte, chunk count and cadence,
 * chunk size).
 *
 * Every content chunk carries `"bench_t":<send time>` — wall-clock ms with a
 * fractional part, from `performance.timeOrigin + performance.now()`, which is
 * comparable across processes on one host. The load generator subtracts it from
 * the time the chunk reached IT, so the bench measures what Fest adds to each
 * chunk rather than inferring it from totals. Fest relays the bytes untouched,
 * so the stamp survives the trip.
 *
 * Its own process, forked by `run.ts`, so its CPU is not the gateway's. It
 * reports its event-loop utilisation on request: if the upstream saturates, the
 * numbers describe the bench, not Fest, and the report says so.
 *
 *   fork("upstream.ts", [JSON.stringify(shape)]) → { t: "listening", port }
 *   send { t: "stats" }                           → { t: "stats", elu, streams, requests }
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";

export interface TurnShape {
  /** Delay before the response headers and `message_start`. */
  readonly ttfbMs: number;
  /** Content chunks per turn. */
  readonly chunks: number;
  /** Gap between chunks. */
  readonly chunkIntervalMs: number;
  /** Characters of text per chunk. Claude Code's deltas are small. */
  readonly chunkChars: number;
}

export const nowMs = (): number => performance.timeOrigin + performance.now();

const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ".repeat(64);

function frame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

export function startUpstream(shape: TurnShape, port = 0): Promise<{ server: http.Server; port: number; stats: () => { streams: number; requests: number } }> {
  let open = 0;
  let requests = 0;
  const text = JSON.stringify(FILLER.slice(0, shape.chunkChars));

  const server = http.createServer((req, res) => {
    requests += 1;
    const url = req.url ?? "/";
    // Drain the body without keeping it: Claude Code sends large contexts, and
    // the bench measures Fest relaying them, not this process buffering them.
    req.resume();
    req.on("end", () => {
      if (url.includes("/v1/messages/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"input_tokens":1234}');
        return;
      }
      if (!url.includes("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"type":"error","error":{"type":"not_found_error","message":"bench upstream"}}');
        return;
      }
      open += 1;
      let closed = false;
      res.on("close", () => {
        if (!closed) open -= 1;
        closed = true;
      });
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "request-id": `req_bench_${requests}`,
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-5h-utilization": "0.2",
        });
        res.socket?.setNoDelay(true);
        res.write(
          frame(
            "message_start",
            '{"type":"message_start","message":{"id":"msg_bench","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"usage":{"input_tokens":120,"cache_read_input_tokens":24000,"cache_creation_input_tokens":0,"output_tokens":1}}}',
          ) + frame("content_block_start", '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'),
        );
        let sent = 0;
        const tick = (): void => {
          if (res.destroyed) return;
          if (sent < shape.chunks) {
            sent += 1;
            res.write(
              frame(
                "content_block_delta",
                `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${text}},"bench_t":${nowMs().toFixed(3)}}`,
              ),
            );
            setTimeout(tick, shape.chunkIntervalMs);
            return;
          }
          res.end(
            frame("content_block_stop", '{"type":"content_block_stop","index":0}') +
              frame(
                "message_delta",
                `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":${shape.chunks * 8}}}`,
              ) +
              frame("message_stop", '{"type":"message_stop"}'),
          );
        };
        setTimeout(tick, shape.chunkIntervalMs);
      }, shape.ttfbMs);
    });
  });
  server.keepAliveTimeout = 60_000;
  server.maxConnections = Infinity;

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        stats: () => ({ streams: open, requests }),
      });
    });
  });
}

// Run as a forked child.
if (process.send !== undefined && import.meta.filename === process.argv[1]) {
  const shape = JSON.parse(process.argv[2] ?? "{}") as TurnShape;
  const { port, stats } = await startUpstream(shape);
  let lastElu = performance.eventLoopUtilization();
  process.on("message", (m: { t?: string }) => {
    if (m.t === "stats") {
      const elu = performance.eventLoopUtilization(lastElu);
      lastElu = performance.eventLoopUtilization();
      process.send?.({ t: "stats", elu: elu.utilization, ...stats() });
    }
    if (m.t === "stop") process.exit(0);
  });
  process.on("disconnect", () => process.exit(0));
  process.send({ t: "listening", port });
}
