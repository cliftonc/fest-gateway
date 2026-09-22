/**
 * The in-memory price table: load once at boot, look up per request.
 *
 * Two hard rules, both inherited from the hand-maintained table this replaced:
 *
 *  1. **An unknown model yields `null`, never an estimate.** A guessed rate
 *     that looks plausible is worse than an honest "n/a", because nobody
 *     investigates a number that looks fine.
 *  2. **A gateway must not depend on an external price service to serve a
 *     request.** The vendored snapshot is loaded synchronously at boot and is
 *     always sufficient. `refresh.ts` only ever swaps in something newer.
 *
 * Note the deliberate absence of prefix matching. The old table had 13 entries
 * and matched `claude-opus-4-1-20260101` by longest prefix out of necessity.
 * litellm carries every dated snapshot id explicitly alongside its alias, so
 * prefix matching would now be guessing where an exact answer exists — and it
 * guesses badly: `claude-opus-4-5-20251101` would match a bare `claude-opus`
 * entry at a completely different rate.
 */

import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ModelRate, PriceCatalog, TierRates } from "./catalog.ts";

export type { ModelRate, TierRates, PriceCatalog };

const SNAPSHOT_URL = new URL("./snapshot.json.gz", import.meta.url);

/** The vendored snapshot. Always present, always loadable, never the network. */
export function loadSnapshot(): PriceCatalog {
  const gz = readFileSync(fileURLToPath(SNAPSHOT_URL));
  return JSON.parse(gunzipSync(gz).toString("utf8")) as PriceCatalog;
}

let current: PriceCatalog | null = null;

export function priceCatalog(): PriceCatalog {
  current ??= loadSnapshot();
  return current;
}

/**
 * Swap in a newer catalog. Called only by `refresh.ts` after a successful
 * fetch; a failed refresh leaves the previous table exactly as it was.
 */
export function setPriceCatalog(catalog: PriceCatalog): void {
  current = catalog;
}

/** Test seam: forget the loaded table so the next lookup re-reads the snapshot. */
export function resetPriceCatalog(): void {
  current = null;
}

/** Strip Claude Code's client-side context-window tag before matching. */
function normalise(model: string): string {
  return model.trim().toLowerCase().replace(/\[1m\]$/, "");
}

/**
 * Candidate catalog keys for a model id, most specific first.
 *
 * The provider-qualified forms matter for the substitute path: a route sends
 * `accounts/fireworks/models/deepseek-v4-pro`, which litellm files under
 * `fireworks_ai/accounts/fireworks/models/deepseek-v4-pro`. It also files many
 * Fireworks models under the bare leaf (`fireworks_ai/deepseek-v4-pro-0813`),
 * hence the basename form.
 */
function candidates(id: string, provider: string | undefined): string[] {
  const out = [id];
  if (provider !== undefined && provider !== "") {
    out.push(`${provider}/${id}`);
    const leaf = id.slice(id.lastIndexOf("/") + 1);
    if (leaf !== id) out.push(`${provider}/${leaf}`);
  }
  return out;
}

export function lookupRate(
  model: string | null | undefined,
  provider?: string | undefined,
): ModelRate | null {
  if (model === null || model === undefined || model.trim() === "") return null;
  const { models } = priceCatalog();

  // Raw first, then normalised: an id that matches verbatim should never be
  // reinterpreted by the `[1m]` strip.
  for (const id of [model.trim(), normalise(model)]) {
    for (const key of candidates(id, provider)) {
      const hit = models[key];
      if (hit !== undefined) return hit;
    }
  }
  return null;
}

/**
 * Pick the tier a call is billed at.
 *
 * Long-context tiers are thresholds on the WHOLE request: once context crosses
 * the line the entire call prices at the higher rate, which is how Anthropic
 * and Google both bill it. Priority overrides only the base tier — no vendor
 * currently publishes a priority rate for a long-context tier, so combining
 * them would be inventing a price.
 */
export function tierFor(
  rate: ModelRate,
  contextTokens: number,
  serviceTier: string | undefined,
): TierRates {
  for (let i = rate.tiers.length - 1; i >= 0; i -= 1) {
    const tier = rate.tiers[i];
    if (tier !== undefined && contextTokens > tier.aboveTokens) return tier.rates;
  }
  if (serviceTier === "priority" && rate.priority !== null) return rate.priority;
  return rate.base;
}
