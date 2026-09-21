/**
 * HTTP surface.
 *
 * Routing works off the path with any Fest identity prefix removed, so
 * `/t/<token>/v1/messages?beta=true` and `/v1/messages?beta=true` reach the
 * same handler. The query string is preserved throughout: Phase 0 showed Claude
 * Code calls `/v1/messages?beta=true`, not `/v1/messages`.
 */

import http from "node:http";
import type { Server } from "node:http";
import { parseIdentityPath } from "../auth/posture.ts";
import { anthropicError } from "./errors.ts";
import { handleMessages } from "../pipeline/passthrough.ts";
import type { PassthroughContext } from "../pipeline/passthrough.ts";
import type { UsageSink } from "../ingest/sink.ts";
import type { FestConfig } from "../config.ts";
import { log } from "../log.ts";

export interface ServerDeps {
  readonly config: FestConfig;
  readonly sink: UsageSink;
}

function pathnameOf(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

export function createServer(deps: ServerDeps): Server {
  const ctx: PassthroughContext = {
    upstreamBaseUrl: deps.config.upstreamBaseUrl,
    sink: deps.sink,
    requireIdentity: deps.config.requireIdentity,
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const { remainder } = parseIdentityPath(url);
    const path = pathnameOf(remainder);
    const method = req.method ?? "GET";

    void (async () => {
      try {
        // Claude Code's runtime probes this before any inference, with no
        // credentials. Discovered empirically in Phase 0; it is not part of the
        // documented Anthropic surface, so it would have been missed.
        if (path === "/api/hello") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
          return;
        }

        if (path === "/healthz") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, sink: deps.sink.stats() }));
          return;
        }

        // Phase 1 stand-in for the dashboard: proves metering end to end
        // without a database.
        if (path === "/_admin/usage" && method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify(
              { stats: deps.sink.stats(), recent: deps.sink.recent(100) },
              null,
              2,
            ),
          );
          return;
        }

        // The cheapest possible test for "is something between me and the
        // client buffering my stream". If these arrive one per second, nothing
        // is buffering; if they arrive in a clump at the end, something is.
        if (path === "/_debug/slow-stream") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          });
          res.socket?.setNoDelay(true);
          res.flushHeaders();
          for (let i = 1; i <= 10; i += 1) {
            if (res.writableEnded) return;
            res.write(`event: tick\ndata: {"n":${i},"at":${Date.now()}}\n\n`);
            await new Promise((r) => setTimeout(r, 1000));
          }
          res.end();
          return;
        }

        if (path === "/v1/messages" && method === "POST") {
          await handleMessages(req, res, ctx);
          return;
        }

        // Unknown paths are the early-warning system for Claude Code releases
        // adding endpoints: a warn line here is how we find out before users do.
        log.warn("unhandled path", { method, path });
        res.writeHead(404, { "content-type": "application/json" });
        res.end(anthropicError("not_found_error", `Fest: ${method} ${path} is not implemented.`));
      } catch (err) {
        log.error("unhandled request error", { path, error: String(err).slice(0, 300) });
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(anthropicError("api_error", "Fest: internal error."));
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    })();
  });

  // A long thinking turn must not be killed mid-stream.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 76_000;

  return server;
}
