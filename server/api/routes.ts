/**
 * JSON API for the dashboard.
 *
 * Phase 3 (Vite + React + TanStack Query) consumes these. Kept deliberately
 * thin: every endpoint is a direct projection of one function in
 * `store/queries.ts`, which is where org/member scoping is enforced. No handler
 * builds SQL, so a forgotten filter in a route cannot leak another tenant's
 * data.
 *
 * Authentication is decided before this file runs (see auth/guard.ts) and the
 * result arrives as `scope`. Every query takes that scope explicitly, so there
 * is no ambient "current org" a handler could forget to apply.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../store/db.ts";
import type { Scope, TimeRange } from "../store/queries.ts";
import {
  listRequests,
  usageTotals,
  usageByUser,
  usageByModel,
  usageByCredentialOrigin,
  usageSeries,
  errorBreakdown,
  latencySummary,
  latestQuotaByUser,
} from "../store/queries.ts";
import type { UsageSink } from "../ingest/sink.ts";
import type { LiveBus } from "../ingest/live-bus.ts";
import type { RouteTable } from "../routes/table.ts";
import { explainRoutes } from "./routing-view.ts";
import { ADAPTER_TRANSFORMS } from "../adapters/registry.ts";
import type { SecretResolver } from "../credentials/provider.ts";
import { handleLive } from "./live.ts";
import { listAudit } from "../store/audit.ts";
import type {
  RoutingResponse,
  OverviewResponse,
  RequestsResponse,
  UsersResponse,
  ModelsResponse,
  ErrorsResponse,
  QuotaResponse,
  AuditResponse,
} from "../../shared/api.ts";

const DEFAULT_RANGE_MS = 24 * 3_600_000;
const MAX_RANGE_MS = 400 * 86_400_000;

function intParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * Ranges come from a query string, so they are clamped rather than trusted: an
 * absurd `fromMs` would otherwise turn a dashboard refresh into a full-table
 * scan, and on single-writer SQLite that stalls the metering flush behind it.
 */
export function parseRange(params: URLSearchParams, now = Date.now()): TimeRange {
  const toMs = intParam(params, "to") ?? now;
  const fromRaw = intParam(params, "from") ?? toMs - DEFAULT_RANGE_MS;
  const fromMs = Math.max(fromRaw, toMs - MAX_RANGE_MS);
  return { fromMs: Math.min(fromMs, toMs), toMs };
}

function strParam(params: URLSearchParams, name: string): string | undefined {
  const raw = params.get(name);
  return raw === null || raw.trim() === "" ? undefined : raw;
}

export interface ApiDeps {
  readonly store: Store;
  readonly sink: UsageSink;
  readonly bus: LiveBus;
  readonly routes: RouteTable;
  readonly secrets: SecretResolver;
  /**
   * Who is asking, resolved from the session cookie by the guard. Not an orgId
   * plus an assumed role: the role decides what the audit endpoint returns, and
   * a caller must never be able to widen it by choosing a query parameter.
   */
  readonly scope: Scope;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(payload);
}

/**
 * Handle an `/api/*` request. Returns false when the path is not ours, so the
 * caller can fall through to its own 404.
 */
export function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: ApiDeps,
): boolean {
  if (!path.startsWith("/api/")) return false;
  if ((req.method ?? "GET") !== "GET") {
    json(res, 405, { error: "method not allowed" });
    return true;
  }

  const url = new URL(req.url ?? "/", "http://fest.local");
  const params = url.searchParams;
  const range = parseRange(params);
  const scope = deps.scope;

  // SSE, so it owns its own response lifecycle and must not fall through to
  // the JSON writer below.
  if (path === "/api/live") {
    handleLive(req, res, deps.bus);
    return true;
  }

  switch (path) {
    case "/api/overview":
      json(res, 200, {
        range,
        totals: usageTotals(deps.store, scope, range),
        series: usageSeries(deps.store, scope, range),
        byCredentialOrigin: usageByCredentialOrigin(deps.store, scope, range),
        latency: latencySummary(deps.store, scope, range),
        sink: deps.sink.stats(),
      } satisfies OverviewResponse);
      return true;

    case "/api/requests": {
      const filter = {
        ...(strParam(params, "userId") !== undefined ? { userId: strParam(params, "userId") } : {}),
        ...(strParam(params, "model") !== undefined ? { servedModel: strParam(params, "model") } : {}),
        ...(strParam(params, "credentialOrigin") !== undefined
          ? { credentialOrigin: strParam(params, "credentialOrigin") }
          : {}),
        ...(strParam(params, "sessionId") !== undefined ? { sessionId: strParam(params, "sessionId") } : {}),
        ...(params.get("errorsOnly") === "1" ? { errorsOnly: true } : {}),
        ...(intParam(params, "before") !== undefined ? { beforeSeq: intParam(params, "before") } : {}),
        ...(intParam(params, "limit") !== undefined ? { limit: intParam(params, "limit") } : {}),
      };
      json(res, 200, listRequests(deps.store, scope, filter) satisfies RequestsResponse);
      return true;
    }

    case "/api/users":
      json(res, 200, { range, rows: usageByUser(deps.store, scope, range) } satisfies UsersResponse);
      return true;

    case "/api/models":
      json(res, 200, { range, rows: usageByModel(deps.store, scope, range) } satisfies ModelsResponse);
      return true;

    case "/api/errors":
      json(res, 200, {
        range,
        rows: errorBreakdown(deps.store, scope, range),
        latency: latencySummary(deps.store, scope, range),
      } satisfies ErrorsResponse);
      return true;

    // For a subscription developer this, not cost, is the scarce resource.
    // The routing table, so an operator can see what Fest will do without
    // reading the config file on the server. No secret can appear here: the
    // table holds references, not values.
    case "/api/routing":
      json(res, 200, {
        version: deps.routes.version,
        enabled: deps.routes.routes.length > 0,
        upstreams: [...deps.routes.upstreams.values()].map((u) => ({
          id: u.id,
          adapter: u.adapter,
          baseUrl: u.baseUrl,
          credentialSource: u.credential.source,
          credentialPresent: deps.secrets.resolve(u.credential) !== null,
          transforms: ADAPTER_TRANSFORMS[u.adapter] ?? [],
        })),
        // Already in evaluation order, each row carrying what it claims and
        // what it adds — see `routing-view.ts` for why the dashboard is not
        // left to infer either from the pattern.
        routes: explainRoutes(deps.routes).map(({ route, shadows, outranked, menuIds }) => ({
          id: route.id,
          match: route.match,
          upstream: route.upstream,
          model: route.model,
          expose: route.expose,
          shadows,
          outranked,
          menuIds,
        })),
      } satisfies RoutingResponse);
      return true;

    // Admin-only. A member can see the traffic they are part of; who was
    // granted console access, and whose login failed, is not that.
    case "/api/audit": {
      if (scope.role === "member") {
        json(res, 403, { error: "admin access required" });
        return true;
      }
      const opts = {
        ...(intParam(params, "limit") !== undefined ? { limit: intParam(params, "limit") } : {}),
        ...(intParam(params, "before") !== undefined ? { beforeSeq: intParam(params, "before") } : {}),
      };
      json(res, 200, { rows: listAudit(deps.store, scope.orgId, opts) } satisfies AuditResponse);
      return true;
    }

    case "/api/quota":
      json(res, 200, { rows: latestQuotaByUser(deps.store, scope) } satisfies QuotaResponse);
      return true;

    default:
      json(res, 404, { error: `no such endpoint: ${path}` });
      return true;
  }
}
