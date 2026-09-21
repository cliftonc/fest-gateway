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

export function buildModelMenu(table: RouteTable): ModelEntry[] {
  // Candidate ids: the models Anthropic offers, plus any CONCRETE route match.
  // A wildcard pattern is not a candidate — `claude-sonnet-*` is not something a
  // developer can type or select.
  const candidates = new Map<string, string>();
  for (const model of BASE_MODELS) candidates.set(model.id, model.name);
  for (const route of table.routes) {
    if (!route.match.includes("*")) candidates.set(route.match, candidates.get(route.match) ?? route.match);
  }

  const entries: ModelEntry[] = [];
  for (const [id, name] of candidates) {
    // Client-side, Claude Code drops any id not matching /(claude|anthropic)/i,
    // so publishing one would make the entry vanish rather than appear.
    if (!CLIENT_VISIBLE.test(id)) continue;

    // Resolve through the REAL router rather than re-implementing matching.
    // This is what makes a wildcard route visible in the menu: the pattern
    // cannot be published, but its EFFECT on each concrete id can be, and the
    // two can never disagree because they run the same code.
    const decision = resolveRoute(table, id);
    const display =
      decision.pipeline === "substitute" && decision.upstream !== null
        ? // Naming the destination is the whole point. A developer choosing
          // "Sonnet 5" and silently getting Kimi is precisely the substitution
          // this project exists to prevent, and the model picker is the first
          // place they would not notice.
          `${name} → ${decision.upstream.id}`
        : name;

    entries.push({ type: "model", id, display_name: display, created_at: "1970-01-01T00:00:00Z" });
  }
  return entries;
}

export function handleModels(res: ServerResponse, table: RouteTable, ifNoneMatch?: string): void {
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
  res.end(JSON.stringify({ data: buildModelMenu(table), has_more: false, first_id: null, last_id: null }));
}
