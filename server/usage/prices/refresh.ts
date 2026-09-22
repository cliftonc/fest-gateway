/**
 * Keeping prices current without ever making the gateway depend on the network.
 *
 * The contract, in order of importance:
 *
 *  1. Boot always succeeds and always has prices. The vendored snapshot is
 *     enough; a clone with no network, a CI run and an airgapped container all
 *     price correctly.
 *  2. A refresh that fails changes NOTHING. No half-written cache, no cleared
 *     table, no thrown error — a warn line and the previous rates.
 *  3. No request ever waits on a fetch. The refresh runs on an unref'd timer
 *     off the hot path, and swaps a whole catalog in one assignment.
 *
 * Prices drift slowly (a vendor repricing is a quarterly event, not a daily
 * one), so a 24h cadence is generous. The point of refreshing at all is that a
 * *new model* appears the week it ships, and an unpriced model is a row the
 * dashboard has to report as "n/a".
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../../log.ts";
import { LITELLM_URL, normaliseCatalog } from "./catalog.ts";
import type { PriceCatalog } from "./catalog.ts";
import { loadSnapshot, setPriceCatalog } from "./table.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface PricingOptions {
  /** Where a refreshed catalog is cached between restarts. */
  readonly cachePath: string;
  readonly refreshEnabled: boolean;
  readonly url: string;
}

export function pricingOptionsFromEnv(dbPath: string): PricingOptions {
  const raw = (process.env.FEST_PRICING_REFRESH ?? "").trim().toLowerCase();
  return {
    // Next to the database, so the one writable volume an operator already
    // mounts carries the cache too.
    cachePath: `${dirname(dbPath)}/prices.json`,
    refreshEnabled: !["0", "false", "no", "off"].includes(raw),
    url: (process.env.FEST_PRICING_URL ?? "").trim() || LITELLM_URL,
  };
}

/**
 * Load the best catalog available, synchronously, at boot.
 *
 * The cache wins only if it is genuinely NEWER than the snapshot. That
 * comparison is on `fetchedAt` rather than file mtime because the failure it
 * prevents is real: upgrading Fest ships a newer snapshot, and a stale
 * `data/prices.json` left in the volume would otherwise shadow it forever.
 */
export function loadPrices(opts: Pick<PricingOptions, "cachePath">): PriceCatalog {
  const snapshot = loadSnapshot();

  let cached: PriceCatalog | null = null;
  try {
    cached = JSON.parse(readFileSync(opts.cachePath, "utf8")) as PriceCatalog;
  } catch {
    // No cache, or one this build cannot read. The snapshot is always enough.
  }

  const chosen =
    cached !== null && typeof cached.fetchedAt === "number" && cached.fetchedAt > snapshot.fetchedAt
      ? cached
      : snapshot;

  setPriceCatalog(chosen);
  log.info("prices loaded", {
    models: Object.keys(chosen.models).length,
    fetchedAt: new Date(chosen.fetchedAt).toISOString(),
    from: chosen === snapshot ? "snapshot" : "cache",
  });
  return chosen;
}

async function fetchCatalog(url: string): Promise<PriceCatalog> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normaliseCatalog(await res.json(), { source: url, fetchedAt: Date.now() });
}

/**
 * One refresh attempt. Never throws, never partially applies.
 *
 * The catalog is validated by `normaliseCatalog` (which throws on an empty or
 * malformed file) BEFORE anything is written or swapped, so a truncated
 * response cannot leave Fest pricing from a table with three models in it.
 */
export async function refreshPricesOnce(opts: PricingOptions): Promise<boolean> {
  try {
    const catalog = await fetchCatalog(opts.url);

    // Atomic: a crash mid-write leaves the old cache, never a torn one.
    mkdirSync(dirname(opts.cachePath), { recursive: true });
    const tmp = `${opts.cachePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(catalog));
    renameSync(tmp, opts.cachePath);

    setPriceCatalog(catalog);
    log.info("prices refreshed", { models: Object.keys(catalog.models).length, url: opts.url });
    return true;
  } catch (err) {
    log.warn("price refresh failed, keeping current rates", {
      url: opts.url,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export interface PriceRefresher {
  stop(): void;
}

/**
 * Start the background refresh loop. Returns a handle whose `stop` is safe to
 * call more than once, so shutdown ordering never has to be careful.
 *
 * Both timers are `unref`'d: prices must never be the reason the process won't
 * exit, and a short-lived CLI command that happens to load the table should not
 * hang for 24 hours waiting for a tick.
 */
export function startPriceRefresh(opts: PricingOptions): PriceRefresher {
  if (!opts.refreshEnabled) {
    log.info("price refresh disabled", { reason: "FEST_PRICING_REFRESH" });
    return { stop: () => {} };
  }

  const timers: NodeJS.Timeout[] = [];

  // Deferred rather than awaited: boot must not wait on GitHub.
  timers.push(setTimeout(() => void refreshPricesOnce(opts), 0).unref());
  timers.push(setInterval(() => void refreshPricesOnce(opts), DAY_MS).unref());

  return {
    stop: () => {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    },
  };
}
