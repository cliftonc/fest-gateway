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
import type { Store } from "../store/db.ts";
import { handleApi } from "../api/routes.ts";
import type { LiveBus } from "../ingest/live-bus.ts";
import { createStaticHost } from "./static.ts";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { log } from "../log.ts";

export interface ServerDeps {
  readonly config: FestConfig;
  readonly sink: UsageSink;
  readonly bus: LiveBus;
  readonly orgId: string;
  readonly store: Store;
  readonly resolveIdentity: (raw: string | null) => { tokenId: string; userId: string } | null;
  readonly touchToken?: ((tokenId: string) => void) | undefined;
}

function pathnameOf(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/** `web/dist`, relative to this file, so it resolves from any cwd. */
const WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");

export function createServer(deps: ServerDeps): Server {
  const web = createStaticHost(WEB_DIST);
  if (!web.available) {
    log.info("dashboard bundle not built; serving API only", { expected: WEB_DIST });
  }

  const ctx: PassthroughContext = {
    upstreamBaseUrl: deps.config.upstreamBaseUrl,
    sink: deps.sink,
    requireIdentity: deps.config.requireIdentity,
    orgId: deps.orgId,
    resolveIdentity: deps.resolveIdentity,
    touchToken: deps.touchToken,
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

        // Dashboard JSON API. Every endpoint is a projection of one function in
        // store/queries.ts, where org and member scoping is enforced.
        if (
          handleApi(req, res, path, {
            store: deps.store,
            sink: deps.sink,
            bus: deps.bus,
            orgId: deps.orgId,
          })
        ) {
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

        // The dashboard, when built. Last, so it can never shadow the proxy or
        // the API, and narrow enough that an unknown /v1/ path still 404s.
        if ((method === "GET" || method === "HEAD") && web.serve(res, path)) return;

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
