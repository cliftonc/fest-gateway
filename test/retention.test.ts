import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, migrate } from "../server/store/db.ts";
import type { Store } from "../server/store/db.ts";
import { ensureOrg } from "../server/store/bootstrap.ts";
import { runRetention } from "../server/store/retention.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function setup(t: any): { store: Store; orgId: string } {
  const dir = mkdtempSync(join(tmpdir(), "fest-ret-"));
  const store = openStore(join(dir, "f.db"));
  migrate(store);
  const org = ensureOrg(store);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, orgId: org.id };
}

function insertRequest(store: Store, orgId: string, startedAt: number, id: string): void {
  store.db
    .prepare(
      `INSERT INTO requests (id, org_id, started_at, ended_at, posture, identity_carrier,
         credential_origin, upstream, status)
       VALUES (?, ?, ?, ?, 'subscription', 'path', 'inbound_subscription', 'up', 'ok')`,
    )
    .run(id, orgId, startedAt, startedAt + 1);
}

function insertRollup(store: Store, orgId: string, hourStart: number): void {
  store.db
    .prepare(
      `INSERT INTO usage_hourly (org_id, hour_start, user_id, served_model,
         credential_origin, cost_basis, requests)
       VALUES (?, ?, '', '', 'inbound_subscription', 'subscription', 1)`,
    )
    .run(orgId, hourStart);
}

const countRequests = (s: Store): number =>
  Number((s.db.prepare("SELECT count(*) c FROM requests").get() as { c: number }).c);
const countRollups = (s: Store): number =>
  Number((s.db.prepare("SELECT count(*) c FROM usage_hourly").get() as { c: number }).c);

test("raw rows age out while aggregate rollups survive", (t) => {
  const { store, orgId } = setup(t);

  insertRequest(store, orgId, NOW - 40 * DAY, "old");
  insertRequest(store, orgId, NOW - 5 * DAY, "recent");
  // Rollups are aggregate, so they outlive the privacy-bearing raw rows.
  insertRollup(store, orgId, NOW - 40 * DAY);
  insertRollup(store, orgId, NOW - 500 * DAY);

  const res = runRetention(store, { requestDays: 30, rollupDays: 400 }, NOW);

  assert.equal(res.requestsDeleted, 1);
  assert.equal(countRequests(store), 1);
  // The 40-day-old rollup stays: that is the point of keeping them.
  assert.equal(res.rollupsDeleted, 1);
  assert.equal(countRollups(store), 1);
});

test("the cutoff is exclusive and nothing recent is touched", (t) => {
  const { store, orgId } = setup(t);
  // Exactly at the boundary must survive: started_at < cutoff is the test.
  insertRequest(store, orgId, NOW - 30 * DAY, "boundary");
  insertRequest(store, orgId, NOW - 30 * DAY - 1, "just-over");

  runRetention(store, { requestDays: 30, rollupDays: 400 }, NOW);

  const ids = store.db.prepare("SELECT id FROM requests ORDER BY id").all() as Array<{ id: string }>;
  assert.deepEqual(ids.map((r) => r.id), ["boundary"]);
});

test("deletes in bounded batches so the write lock is never held long", (t) => {
  const { store, orgId } = setup(t);
  for (let i = 0; i < 25; i += 1) insertRequest(store, orgId, NOW - 40 * DAY, `old-${i}`);
  insertRequest(store, orgId, NOW, "keep");

  // A batch size far below the row count forces multiple passes; all old rows
  // must still be gone when it returns.
  const res = runRetention(store, { requestDays: 30, rollupDays: 400, batchSize: 4 }, NOW);

  assert.equal(res.requestsDeleted, 25);
  assert.equal(countRequests(store), 1);
});

test("a sweep with nothing to do is a no-op", (t) => {
  const { store, orgId } = setup(t);
  insertRequest(store, orgId, NOW, "fresh");
  const res = runRetention(store, { requestDays: 30, rollupDays: 400 }, NOW);
  assert.deepEqual(res, { requestsDeleted: 0, rollupsDeleted: 0 });
  assert.equal(countRequests(store), 1);
});

test("retention is idempotent", (t) => {
  const { store, orgId } = setup(t);
  insertRequest(store, orgId, NOW - 40 * DAY, "old");
  runRetention(store, { requestDays: 30, rollupDays: 400 }, NOW);
  const second = runRetention(store, { requestDays: 30, rollupDays: 400 }, NOW);
  assert.deepEqual(second, { requestsDeleted: 0, rollupsDeleted: 0 });
});
