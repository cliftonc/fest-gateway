/**
 * Pick a route for a requested model.
 *
 * Matching is first-match-wins in file order, with exact matches preferred over
 * wildcards regardless of where they sit in the file.
 *
 * That last rule is worth stating plainly, because "first match wins" and
 * "exact beats wildcard" are the two conventions people expect and they
 * disagree. The reason exactness wins here: a table almost always contains a
 * broad rule (`claude-*` -> somewhere cheap) plus a handful of deliberate
 * exceptions. If file order alone decided, adding a new exception would require
 * remembering to put it above the catch-all, and forgetting would silently
 * route a model somewhere the operator did not intend — with no error, because
 * both rules are individually valid.
 *
 * Within a tier, longer patterns win before file order, so `claude-opus-*`
 * beats `claude-*` however they are written down.
 */

import type { Route, RouteTable, Upstream } from "./table.ts";

export interface RouteDecision {
  /**
   * Null when no route matched; the default pass-through applies.
   *
   * Also null on a substitute decision made by `resolveWithoutCallerCredential`,
   * which routes by adapter rather than by any entry in the file. A record with
   * `pipeline: "substitute"` and `routeId: null` means exactly that: substituted,
   * but not by a route an operator wrote — so looking for one in `routes.json`
   * is not a search worth starting.
   */
  readonly route: Route | null;
  /** Null on the pass-through path. */
  readonly upstream: Upstream | null;
  /** What the request asked for. */
  readonly requestedModel: string | null;
  /** What will actually be sent upstream. Equal to requested unless rewritten. */
  readonly servedModel: string | null;
  readonly pipeline: "passthrough" | "substitute";
}

function matches(pattern: string, model: string): boolean {
  if (pattern.endsWith("*")) return model.startsWith(pattern.slice(0, -1));
  return pattern === model;
}

/**
 * Does this route claim this model id?
 *
 * A route's `expose` alias is an exact match for it. The menu and the router
 * therefore agree by construction: every id Fest publishes is an id Fest can
 * route, and there is no way to publish one without routing it.
 */
function claims(route: Route, model: string): boolean {
  return route.expose === model || matches(route.match, model);
}

/** Exact rules first, then longest pattern, then file order. */
function rank(route: Route, index: number, model?: string): [number, number, number] {
  // An alias hit is always exact, however wildcard the route's own match is:
  // the developer selected this entry by name from the menu.
  const exact = model !== undefined && route.expose === model ? true : !route.match.endsWith("*");
  return [exact ? 0 : 1, -route.match.length, index];
}

function better(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
}

export function resolveRoute(table: RouteTable, requestedModel: string | null): RouteDecision {
  const passthrough: RouteDecision = {
    route: null,
    upstream: null,
    requestedModel,
    servedModel: requestedModel,
    pipeline: "passthrough",
  };

  // A request with no readable model cannot be routed. It stays on the
  // pass-through path rather than falling into a wildcard: routing a request we
  // could not identify is exactly how traffic ends up somewhere unintended.
  if (requestedModel === null || requestedModel === "") return passthrough;

  let best: Route | null = null;
  let bestRank: [number, number, number] | null = null;

  table.routes.forEach((route, index) => {
    if (!claims(route, requestedModel)) return;
    const r = rank(route, index, requestedModel);
    if (bestRank === null || better(r, bestRank)) {
      best = route;
      bestRank = r;
    }
  });

  if (best === null) return passthrough;
  const route: Route = best;

  // A route with a null upstream is a deliberate "keep this one on the
  // subscription", which is how an operator carves an exception out of a
  // broad substitution rule.
  if (route.upstream === null) {
    return { ...passthrough, route };
  }

  const upstream = table.upstreams.get(route.upstream);
  if (upstream === undefined) {
    // Unreachable via parseRouteTable, which rejects unknown upstreams at boot.
    // Kept as a fail-safe rather than a `!`: if it ever happens, passing the
    // request through is the outcome that cannot leak a credential.
    return { ...passthrough, route };
  }

  return {
    route,
    upstream,
    requestedModel,
    servedModel: route.model ?? requestedModel,
    pipeline: "substitute",
  };
}

/** Client-visible Anthropic-ish ids — the same filter Claude Code applies. */
const ANTHROPIC_MODEL = /(claude|anthropic)/i;

/**
 * The upstream that serves Anthropic models nothing else claims.
 *
 * Identified by ADAPTER, not by the id an operator happened to type: the
 * `anthropic` adapter is by definition "Anthropic's own API on a key the server
 * holds", and that is the property that makes it a safe default. Naming an
 * upstream `anthropic` while pointing it somewhere else would otherwise decide
 * where unrouted traffic goes.
 */
export function defaultAnthropicUpstream(table: RouteTable): Upstream | null {
  for (const upstream of table.upstreams.values()) {
    if (upstream.adapter === "anthropic") return upstream;
  }
  return null;
}

/**
 * Resolve for a request that has NO caller credential to pass through.
 *
 * This is the key posture: the credential position holds Fest's own identity
 * token, which is never forwarded, so pass-through cannot serve anything. An
 * unrouted model there is not "left on the subscription" — there is no
 * subscription — it is a guaranteed failure on the first message.
 *
 * So when the operator has defined an `anthropic` upstream, every Anthropic
 * model that no route claims is served there, on the org's own key. The
 * alternative was one exact-match route per model id, which has to be updated
 * every time Anthropic ships a model and fails silently — as a first-message
 * 401 — when someone forgets.
 *
 * Three things it deliberately does NOT do:
 *
 *  - **It never runs in the subscription posture.** That path keeps a caller
 *    credential, and diverting it to a server-held key would bill the org for
 *    a request the developer's own plan had already covered. This function is
 *    reached only where `upstreamCredential === null`, and a plain wildcard
 *    route in `routes.json` could not express that distinction — `resolveRoute`
 *    is posture-blind, so `claude-*` -> anthropic would capture subscription
 *    traffic too. That is why this is code and not config.
 *  - **It never overrides an explicit route.** A model claimed by any route,
 *    including an `upstream: null` "keep this on pass-through" carve-out, is
 *    left exactly where the operator put it.
 *  - **It never routes a non-Anthropic id.** Sending `gpt-oss-120b` to
 *    api.anthropic.com buys a confusing 404 from a vendor who never had that
 *    model, in place of Fest's own message naming the gateway.
 */
export function resolveWithoutCallerCredential(
  table: RouteTable,
  requestedModel: string | null,
): RouteDecision {
  const decision = resolveRoute(table, requestedModel);
  // Already substituted, or claimed by an explicit route: not ours to redirect.
  if (decision.pipeline === "substitute" || decision.route !== null) return decision;
  if (requestedModel === null || requestedModel === "") return decision;
  if (!ANTHROPIC_MODEL.test(requestedModel)) return decision;

  const upstream = defaultAnthropicUpstream(table);
  if (upstream === null) return decision;

  return {
    route: null,
    upstream,
    requestedModel,
    // Anthropic's own id, unchanged. This is a credential substitution, not a
    // model one: the developer asked for Sonnet and gets Sonnet.
    servedModel: requestedModel,
    pipeline: "substitute",
  };
}

/**
 * Routes in the order they are actually evaluated.
 *
 * Exposed for the dashboard because the file's order is NOT the evaluation
 * order, and showing an operator the file would be showing them something
 * subtly untrue. Seeing exceptions sorted above the catch-all they override is
 * the fastest way to confirm a table does what its author meant.
 */
export function evaluationOrder(table: RouteTable): Route[] {
  return table.routes
    .map((route, index) => ({ route, r: rank(route, index) }))
    .sort((a, b) => (better(a.r, b.r) ? -1 : 1))
    .map((x) => x.route);
}
