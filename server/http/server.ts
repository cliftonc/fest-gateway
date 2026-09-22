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
import { dispatchMessages } from "../pipeline/dispatch.ts";
import type { DispatchContext } from "../pipeline/dispatch.ts";
import { EMPTY_ROUTE_TABLE } from "../routes/table.ts";
import type { RouteTable } from "../routes/table.ts";
import { createEnvResolver } from "../credentials/provider.ts";
import type { SecretResolver } from "../credentials/provider.ts";
import type { UsageSink } from "../ingest/sink.ts";
import type { FestConfig } from "../config.ts";
import type { Store } from "../store/db.ts";
import { handleApi } from "../api/routes.ts";
import { handleAuth } from "../api/auth.ts";
import { authorizeApi } from "../auth/guard.ts";
import { handleModels } from "../api/models.ts";
import { handleCountTokens } from "../pipeline/count-tokens.ts";
import { handleMessages } from "../pipeline/passthrough.ts";
import { splitBedrockMount, refuseUnconfigured } from "../pipeline/bedrock.ts";
import { detectInbound } from "../auth/posture.ts";
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
  /**
   * Model routing. Absent means everything passes through, which is the default.
   *
   * A FUNCTION rather than a value so the table can be hot-reloaded: every
   * request asks for the current one. Passing a value would capture whatever
   * was loaded at boot and quietly ignore every later edit.
   */
  readonly routes?: RouteTable | (() => RouteTable) | undefined;
  /** Injected so tests can resolve credentials without touching process.env. */
  readonly secrets?: SecretResolver | undefined;
}

function pathnameOf(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/** `web/dist`, relative to this file, so it resolves from any cwd. */
const WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");

/**
 * Drop the mount prefix from an incoming path, if it is still on it.
 *
 * Whether it is depends on the proxy: Caddy's `handle_path` and nginx's
 * `proxy_pass` with a trailing slash strip it, a bare `reverse_proxy` inside a
 * `handle` block does not. Accepting both means a working deployment does not
 * hinge on which of those the operator reached for. `/fest` with nothing after
 * it becomes `/`, not the empty string, because everything downstream matches
 * on a leading slash.
 */
export function stripBasePath(url: string, basePath: string): string {
  if (basePath === "" || !url.startsWith(basePath)) return url;
  const rest = url.slice(basePath.length);
  if (rest === "") return "/";
  if (rest.startsWith("?")) return `/${rest}`;
  // Only a real segment boundary counts: `/festival` must not be read as
  // `/fest` + `ival`.
  return rest.startsWith("/") ? rest : url;
}

export function createServer(deps: ServerDeps): Server {
  const basePath = deps.config.basePath;
  const web = createStaticHost(WEB_DIST, basePath);
  if (!web.available) {
    log.info("dashboard bundle not built; serving API only", { expected: WEB_DIST });
  }

  const configured = deps.routes;
  const routesOf: () => RouteTable =
    typeof configured === "function" ? configured : () => configured ?? EMPTY_ROUTE_TABLE;

  const ctx: DispatchContext = {
    upstreamBaseUrl: deps.config.upstreamBaseUrl,
    sink: deps.sink,
    requireIdentity: deps.config.requireIdentity,
    orgId: deps.orgId,
    resolveIdentity: deps.resolveIdentity,
    touchToken: deps.touchToken,
    routes: EMPTY_ROUTE_TABLE,
    secrets: deps.secrets ?? createEnvResolver(),
  };

  const server = http.createServer((req, res) => {
    const url = stripBasePath(req.url ?? "/", basePath);
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

        // Everything under /api/ is the dashboard, and needs a human session.
        // The proxy path below is authenticated completely differently, by a
        // developer's identity token — a developer must never have to sign in
        // to a web page before their editor works.
        if (path.startsWith("/api/")) {
          const decision = authorizeApi(req, {
            store: deps.store,
            orgId: deps.orgId,
            bindHost: deps.config.host,
            secureCookies: deps.config.secureCookies,
          });

          // Login and "who am I" are reachable without a session, by
          // definition. They still see the decision's session when there is one.
          if (
            await handleAuth(req, res, path, {
              store: deps.store,
              orgId: deps.orgId,
              secureCookies: deps.config.secureCookies,
              config: deps.config,
            }, decision.allow ? decision.session : null)
          ) {
            return;
          }

          if (!decision.allow) {
            res.writeHead(decision.status, {
              "content-type": "application/json",
              "cache-control": "no-store",
            });
            res.end(JSON.stringify({ error: decision.error }));
            return;
          }

          // Every endpoint is a projection of one function in
          // store/queries.ts, where org and member scoping is enforced.
          // A member sees their own traffic and nobody else's, so their scope
          // carries the user id the query layer filters on. The query layer
          // fails closed without it — a member scope with no userId throws
          // rather than quietly widening to the whole org — which is how this
          // wiring bug surfaced as a 500 in a test instead of as a data leak.
          const scope = decision.session === null
            // Unclaimed and on loopback: the guard already refused this case on
            // any other interface.
            ? { orgId: deps.orgId, role: "admin" as const }
            : {
                orgId: decision.session.orgId,
                role: decision.session.role,
                ...(decision.session.role === "member" ? { userId: decision.session.userId } : {}),
              };

          if (
            handleApi(req, res, path, {
              store: deps.store,
              sink: deps.sink,
              bus: deps.bus,
              routes: routesOf(),
              secrets: ctx.secrets,
              scope,
            })
          ) {
            return;
          }
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

        // The model menu Claude Code renders under `/model`, labelled "From
        // gateway". Only ever reached in the key posture — discovery needs a
        // credential in ANTHROPIC_AUTH_TOKEN, which is what disables
        // subscription auth in the first place.
        if (path === "/v1/models" && (method === "GET" || method === "HEAD")) {
          const inm = req.headers["if-none-match"];
          handleModels(res, routesOf(), Array.isArray(inm) ? inm[0] : inm);
          return;
        }

        /**
         * Claude in Amazon Bedrock, on the developer's own AWS credential.
         *
         * Checked BEFORE the Anthropic paths and handled by `handleMessages`
         * directly rather than through `dispatchMessages`: this mount means
         * "relay on MY credential", so routing — which could substitute a
         * server-held key — must not get a vote. See `pipeline/bedrock.ts`.
         */
        // Split from `remainder`, not `path`: the query string has to survive.
        // Phase 0 established that Claude Code calls `/v1/messages?beta=true`
        // and that the parameter is load-bearing, so an override built from the
        // bare pathname would quietly relay a different request.
        const bedrockRemainder = splitBedrockMount(remainder);
        if (bedrockRemainder !== null && method === "POST") {
          if (deps.config.bedrockBaseUrl === null) {
            refuseUnconfigured(res);
            return;
          }
          const bedrockPath = pathnameOf(bedrockRemainder);
          const bedrock = {
            upstreamBaseUrl: deps.config.bedrockBaseUrl,
            // Bedrock files some ids only under `bedrock_mantle/…`; without the
            // hint Haiku 4.5 meters fine and prices as "n/a".
            priceProvider: "bedrock_mantle",
          };
          if (bedrockPath === "/v1/messages") {
            await handleMessages(req, res, { ...ctx, ...bedrock, pathOverride: bedrockRemainder });
            return;
          }
          if (bedrockPath === "/v1/messages/count_tokens") {
            const inbound = detectInbound(url, req.headers);
            await handleCountTokens(req, res, {
              upstreamBaseUrl: bedrock.upstreamBaseUrl,
              path: bedrockRemainder,
              posture: inbound.posture,
            });
            return;
          }
          // Any other path under the mount falls through to the 404 below: the
          // mount forwards the two endpoints Bedrock actually serves, and
          // inventing a relay for the rest would proxy traffic nobody has
          // verified.
        }

        // Relayed, never metered: it consumes no tokens, and counting it would
        // drag every per-request average toward zero.
        if (path === "/v1/messages/count_tokens" && method === "POST") {
          const inbound = detectInbound(url, req.headers);
          await handleCountTokens(req, res, {
            upstreamBaseUrl: deps.config.upstreamBaseUrl,
            path: inbound.effectivePath,
            posture: inbound.posture,
          });
          return;
        }

        if (path === "/v1/messages" && method === "POST") {
          await dispatchMessages(req, res, { ...ctx, routes: routesOf() });
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
