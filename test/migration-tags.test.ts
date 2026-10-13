/**
 * Migration 007 rebuilds `usage_hourly` to put `tags` in its primary key.
 *
 * A rebuild is the one kind of migration that can lose data quietly — a column
 * left out of the copy reads back as its default — so this applies 001–006 to a
 * real file, writes rollup rows in the OLD shape, then lets `migrate()` do the
 * upgrade and checks every total survived.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, migrate } from "../server/store/db.ts";
import { ensureOrg } from "../server/store/bootstrap.ts";
import { usageTotals, latencySummary } from "../server/store/queries.ts";

const MIGRATIONS = join(import.meta.dirname, "../server/store/migrations");
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

test("migration 007 keeps every existing rollup total", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fest-mig7-"));
  const store = openStore(join(dir, "f.db"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    if (Number(file.slice(0, 3)) > 6) continue;
    store.db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  store.db.exec("PRAGMA user_version = 6");
  const org = ensureOrg(store);

  const insert = store.db.prepare(
    `INSERT INTO usage_hourly (org_id, hour_start, user_id, served_model, credential_origin, cost_basis,
       requests, errors, input_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
       output_tokens, web_searches, cost_usd, unpriced_requests, subscription_requests,
       notional_cost_usd, notional_unpriced_requests,
       duration_ms_sum, duration_ms_max, ttfb_ms_sum, ttfb_count,
       lat_b0, lat_b1, lat_b2, lat_b3, lat_b4, lat_b5)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const hour = Math.floor(NOW / HOUR) * HOUR;
  // Every counter distinct, so a column dropped or swapped in the copy shows.
  insert.run(org.id, hour, "", "", "inbound_key", "list",
    3, 1, 11, 12, 13, 14, 15, 16, 1.25, 1, 0, 2.5, 1, 3000, 2000, 300, 3, 1, 1, 0, 0, 0, 1);
  insert.run(org.id, hour - HOUR, "", "", "inbound_subscription", "subscription",
    2, 0, 21, 22, 23, 24, 25, 26, 0, 0, 2, 4.5, 0, 1000, 600, 200, 2, 2, 0, 0, 0, 0, 0);

  const range = { fromMs: NOW - 2 * 86_400_000, toMs: NOW + HOUR };
  const scope = { orgId: org.id, role: "admin" as const };
  const before = usageTotals(store, scope, range);
  const latencyBefore = latencySummary(store, scope, range);

  assert.equal(migrate(store).version, 7);

  assert.deepEqual(usageTotals(store, scope, range), before);
  assert.deepEqual(latencySummary(store, scope, range), latencyBefore);
  assert.equal(before.requests, 5);
  assert.equal(before.notionalCostUsd, 7);
  const tags = store.db.prepare("SELECT DISTINCT tags FROM usage_hourly").all() as Array<{ tags: string }>;
  assert.deepEqual(tags.map((r) => r.tags), [""], "existing rows become untagged");
  const cols = store.db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === "tags_json"));
});
