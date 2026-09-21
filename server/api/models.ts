/**
 * `GET /v1/models` — the model menu Claude Code shows under `/model`.
 *
 * Claude Code fetches `{base}/v1/models?limit=1000`, expects
 * `{"data":[{id, display_name?, description?}]}`, and renders the result
 * labelled "From gateway". Three details, all verified against the client and
 * all easy to get wrong:
 *
 *  1. **Ids are filtered client-side by `/(claude|anthropic)/i`.** A menu entry
 *     whose id does not match that pattern is silently dropped. So a route to
 *     `accounts/fireworks/models/kimi-k2p7-code` must be published under the id
 *     the developer actually types — the route's `match` — not the provider's
 *     id. That is also the correct thing semantically: `match` is what the
 *     client sends, and the rewrite is Fest's business, not theirs.
 *  2. **The default timeout is 3 seconds.** This handler therefore touches no
 *     network and no database — it is a projection of already-parsed config.
 *  3. **The response is cached by the client** at `<cache>/gateway-models.json`
 *     (mode 0600), so a stale menu outlives a restart. `ETag` is served from the
 *     routing table's content hash to make that cache correct rather than
 *     merely fast.
 *  4. **Entries are DEDUPED against the client's built-in list.** Publishing
 *     `claude-sonnet-5` collides with the built-in Sonnet and is dropped
 *     silently — so a substituted model never shows its destination in the
 *     picker, which is the one place a developer would notice. Verified by
 *     reading the merge in 2.1.278: gateway options are added only
 *     `if(!s.some((he)=>uT(he,U)))`. A route's `expose` alias exists to survive
 *     that: a distinct id like `claude-sonnet-5-fireworks` appears, labelled,
 *     and routes to the same place.
 *
 * ⚠ Discovery is also gated on **`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`**
 * being set on the CLIENT. Without it the client never calls this endpoint at
 * all — confirmed empirically (zero requests) and in the binary
 * (`[Bootstrap] Skipped gateway /v1/models (… not set)`).
 *
 * ⚠ Discovery only happens in the KEY posture. It requires a credential in
 * `ANTHROPIC_AUTH_TOKEN` / `apiKeyHelper` / an API key — which is precisely what
 * disables subscription auth. In 2.1.278 a server-published menu and
 * subscription pass-through are mutually exclusive. Do not design around having
 * both.
 */

import type { ServerResponse } from "node:http";
import type { RouteTable } from "../routes/table.ts";
import { resolveRoute } from "../routes/resolve.ts";

export interface ModelEntry {
  readonly type: "model";
  readonly id: string;
  readonly display_name: string;
  readonly created_at: string;
}

/** Claude Code drops any id that does not look Anthropic-ish. */
const CLIENT_VISIBLE = /(claude|anthropic)/i;

/**
 * Anthropic's own current models, offered when a route does not already cover
 * them, so a gateway menu is a superset of the default experience rather than a
 * replacement that quietly loses Opus.
 */
const BASE_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "claude-opus-5", name: "Opus 5" },
  { id: "claude-sonnet-5", name: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" },
];

/**
 * The menu must advertise only what this gateway can actually serve.
 *
 * `/v1/models` is reached ONLY in the key posture — discovery requires a
 * credential that disables subscription auth — and in that posture there is no
 * caller credential to fall back on. So any published id without a route to a
 * server-held credential is a guaranteed failure the moment someone selects it.
 *
 * The first version published Anthropic's built-in models unconditionally
 * "so routing never loses Opus". That was exactly backwards: it produced a menu
 * entry that 401s on selection. A menu is a promise, and this one must only
 * promise what it can keep.
 */
export function buildModelMenu(table: RouteTable): ModelEntry[] {
  const candidates = new Map<string, string>();
  for (const model of BASE_MODELS) candidates.set(model.id, model.name);
  for (const route of table.routes) {
    if (!route.match.includes("*")) candidates.set(route.match, candidates.get(route.match) ?? route.match);
    // An alias exists precisely to survive the client's dedupe, so it is always
    // a candidate.
    if (route.expose !== null) candidates.set(route.expose, route.expose);
  }

  const entries: ModelEntry[] = [];
  for (const [id, name] of candidates) {
    // Client-side, Claude Code drops any id not matching /(claude|anthropic)/i,
    // so publishing one would make the entry vanish rather than appear.
    if (!CLIENT_VISIBLE.test(id)) continue;

    // Resolve through the REAL router rather than re-implementing matching, so
    // the menu and the request path cannot disagree.
    const decision = resolveRoute(table, id);

    // Unservable in this posture — do not offer it.
    if (decision.pipeline !== "substitute" || decision.upstream === null) continue;

    entries.push({
      type: "model",
      id,
      // Naming the destination is the point. A developer choosing "Sonnet 5"
      // and silently getting Kimi is the substitution this project exists to
      // prevent, and the model picker is the first place they would not notice.
      display_name: `${name} → ${decision.upstream.id}`,
      created_at: "1970-01-01T00:00:00Z",
    });
  }
  return entries;
}

export function handleModels(res: ServerResponse, table: RouteTable, ifNoneMatch?: string): void {
  const models = buildModelMenu(table);

  // Nothing to offer: 404 rather than an empty list. The client treats 404 as
  // "no gateway menu" and falls back to its own built-in models — which is both
  // documented behaviour and the right outcome, since an empty `data` array
  // would leave a developer with a picker that offers nothing.
  if (models.length === 0) {
    res.writeHead(404, { "content-type": "application/json", "x-should-retry": "false" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "no gateway models configured" } }));
    return;
  }

  const etag = `"models-${table.version}"`;
  if (ifNoneMatch === etag) {
    res.writeHead(304, { etag });
    res.end();
    return;
  }
  res.writeHead(200, {
    "content-type": "application/json",
    etag,
    // The menu changes only when routing config does, and the client caches it
    // to disk anyway.
    "cache-control": "no-cache",
  });
  res.end(JSON.stringify({ data: models, has_more: false, first_id: null, last_id: null }));
}
