/**
 * The vendored price catalog, and the refresh that keeps it current.
 *
 * The snapshot tests exist because the catalog is a 66KB binary blob in the
 * repo: nothing about a diff to it is readable, so its contract has to be
 * asserted in code instead. If `npm run prices:sync` ever produces a file that
 * cannot price the models Fest actually routes, that must fail here rather than
 * show up as a dashboard full of "n/a".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { loadSnapshot, lookupRate, priceCatalog, resetPriceCatalog } from "../server/usage/prices/table.ts";
import { normaliseCatalog } from "../server/usage/prices/catalog.ts";
import { loadPrices, refreshPricesOnce } from "../server/usage/prices/refresh.ts";
import { BASE_MODELS } from "../shared/base-models.ts";
import { ADAPTER_PRICE_PROVIDERS } from "../server/adapters/registry.ts";

// ── The snapshot's contract ──────────────────────────────────────────────────

test("the vendored snapshot loads and is not trivially small", () => {
  const catalog = loadSnapshot();
  assert.ok(catalog.models !== undefined);
  // A truncated or wrongly-filtered sync would still parse; a count floor is
  // what actually catches it.
  assert.ok(
    Object.keys(catalog.models).length > 1000,
    `only ${Object.keys(catalog.models).length} models in the snapshot`,
  );
  assert.ok(catalog.fetchedAt > 0);
});

test("every model Fest publishes in its own menu is priceable", () => {
  // `/v1/models` offers these to Claude Code, so metering them and then failing
  // to price them would be Fest's own doing rather than a vendor gap.
  for (const model of BASE_MODELS) {
    assert.ok(lookupRate(model.id), `no rate for published model ${model.id}`);
  }
});

test("every model in routes.example.json is priceable via its adapter", async () => {
  const example = JSON.parse(
    await readFile(new URL("../routes.example.json", import.meta.url), "utf8"),
  ) as {
    upstreams: Record<string, { adapter: keyof typeof ADAPTER_PRICE_PROVIDERS }>;
    routes: Array<{ upstream: string | null; model: string | null }>;
  };

  let checked = 0;
  for (const route of example.routes) {
    if (route.upstream === null || route.model === null) continue;
    const adapter = example.upstreams[route.upstream]?.adapter;
    assert.ok(adapter, `route names an unknown upstream ${route.upstream}`);
    const provider = ADAPTER_PRICE_PROVIDERS[adapter];
    assert.ok(
      lookupRate(route.model, provider),
      `no rate for ${route.model} under provider ${provider}`,
    );
    checked += 1;
  }
  assert.ok(checked > 0, "the example routing table exercised no substitute route");
});

test("every adapter maps to a provider that exists in the catalog", () => {
  const providers = new Set(Object.values(priceCatalog().models).map((m) => m.provider));
  for (const [adapter, provider] of Object.entries(ADAPTER_PRICE_PROVIDERS)) {
    assert.ok(providers.has(provider), `adapter ${adapter} maps to unknown provider ${provider}`);
  }
});

// ── Normalisation ────────────────────────────────────────────────────────────

const RAW = {
  // litellm documents its own schema with this pseudo-entry; it must not become
  // a priceable model.
  sample_spec: { mode: "chat", input_cost_per_token: 1, output_cost_per_token: 1 },
  "test-chat": {
    mode: "chat",
    litellm_provider: "testco",
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
    cache_creation_input_token_cost_above_1hr: 6e-6,
    input_cost_per_token_above_200k_tokens: 6e-6,
    output_cost_per_token_above_200k_tokens: 22.5e-6,
    search_context_cost_per_query: { search_context_size_medium: 0.01 },
  },
  "test-no-cache": {
    mode: "chat",
    litellm_provider: "testco",
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
  },
  "test-embedding": { mode: "embedding", input_cost_per_token: 1e-9 },
  "test-half-priced": { mode: "chat", input_cost_per_token: 1e-6 },
};

test("normalisation converts to per-million and keeps buckets disjoint", () => {
  const c = normaliseCatalog(RAW, { source: "test", fetchedAt: 1 });
  const m = c.models["test-chat"]!;

  assert.equal(m.base.inputPerMillion, 3);
  assert.equal(m.base.outputPerMillion, 15);
  assert.equal(m.base.cacheReadPerMillion, 0.3);
  assert.equal(m.base.cacheWrite5mPerMillion, 3.75);
  assert.equal(m.base.cacheWrite1hPerMillion, 6);
  assert.equal(m.webSearchPerThousand, 10);
  assert.equal(m.provider, "testco");
  assert.deepEqual(
    m.tiers.map((t) => t.aboveTokens),
    [200_000],
  );
  assert.equal(m.tiers[0]?.rates.inputPerMillion, 6);
});

test("normalisation drops what it cannot price rather than guessing", () => {
  const c = normaliseCatalog(RAW, { source: "test", fetchedAt: 1 });
  assert.equal(c.models["sample_spec"], undefined, "litellm's schema doc is not a model");
  assert.equal(c.models["test-embedding"], undefined, "non-chat modes are out of scope");
  // Input but no output: pricing it would undercount every call on it.
  assert.equal(c.models["test-half-priced"], undefined);
});

test("a provider with no published cache rate bills cache as ordinary input", () => {
  const m = normaliseCatalog(RAW, { source: "test", fetchedAt: 1 }).models["test-no-cache"]!;
  assert.equal(m.cacheRatesPublished, false);
  // Not zero (which would claim cache reads are free) and not Anthropic's ×0.1
  // (which would invent a discount this vendor does not offer).
  assert.equal(m.base.cacheReadPerMillion, m.base.inputPerMillion);
  assert.equal(m.base.cacheWrite5mPerMillion, m.base.inputPerMillion);
});

test("a catalog with nothing priceable is rejected, not accepted as empty", () => {
  assert.throws(() => normaliseCatalog({ x: { mode: "embedding" } }, { source: "t", fetchedAt: 1 }));
  assert.throws(() => normaliseCatalog(null, { source: "t", fetchedAt: 1 }));
});

// ── Refresh ──────────────────────────────────────────────────────────────────

function tmp(t: any): string {
  const dir = mkdtempSync(join(tmpdir(), "fest-prices-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    resetPriceCatalog();
  });
  return dir;
}

async function serving(t: any, handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/prices.json`;
}

test("a good refresh swaps the table and caches it", async (t) => {
  const dir = tmp(t);
  const url = await serving(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(RAW));
  });

  const cachePath = join(dir, "prices.json");
  assert.equal(await refreshPricesOnce({ cachePath, url, refreshEnabled: true }), true);

  assert.ok(lookupRate("test-chat"), "the fetched table is live");
  const cached = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.ok(cached.models["test-chat"], "and was persisted for the next boot");
});

test("a failed refresh changes nothing at all", async (t) => {
  const dir = tmp(t);
  const cachePath = join(dir, "prices.json");
  resetPriceCatalog();
  const before = Object.keys(priceCatalog().models).length;

  for (const handler of [
    (_req: any, res: any) => {
      res.writeHead(500);
      res.end("nope");
    },
    // 200 with a body that parses but prices nothing — the case a naive
    // implementation accepts and then serves a dashboard full of "n/a".
    (_req: any, res: any) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ junk: { mode: "embedding" } }));
    },
  ]) {
    const url = await serving(t, handler);
    assert.equal(await refreshPricesOnce({ cachePath, url, refreshEnabled: true }), false);
  }

  assert.equal(Object.keys(priceCatalog().models).length, before, "the table is untouched");
  assert.throws(() => readFileSync(cachePath, "utf8"), "and no cache was written");
  assert.ok(lookupRate("claude-opus-5"), "real models still price");
});

test("boot prefers a newer cache but never an older one", (t) => {
  const dir = tmp(t);
  const cachePath = join(dir, "prices.json");
  const snapshot = loadSnapshot();

  // Stale cache: an upgrade ships a newer snapshot, and a leftover file in the
  // data volume must not shadow it forever.
  writeFileSync(
    cachePath,
    JSON.stringify(normaliseCatalog(RAW, { source: "stale", fetchedAt: snapshot.fetchedAt - 1 })),
  );
  assert.equal(loadPrices({ cachePath }).source, snapshot.source);

  writeFileSync(
    cachePath,
    JSON.stringify(normaliseCatalog(RAW, { source: "fresh", fetchedAt: snapshot.fetchedAt + 1 })),
  );
  assert.equal(loadPrices({ cachePath }).source, "fresh");
});

test("a corrupt cache falls back to the snapshot rather than failing boot", (t) => {
  const dir = tmp(t);
  const cachePath = join(dir, "prices.json");
  writeFileSync(cachePath, "{ not json");

  const loaded = loadPrices({ cachePath });
  assert.equal(loaded.source, loadSnapshot().source);
  assert.ok(lookupRate("claude-opus-5"), "a gateway always has prices");
});
