/**
 * Seed data, and the guard that keeps it away from real traffic.
 *
 * The generator is only worth testing for the properties the DASHBOARD depends
 * on — a subscription row must carry no dollar cost, some rows must be
 * unattributed, and the whole thing must be deterministic so two people looking
 * at "the demo" are looking at the same demo.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateRecords, isDefaultDatabase, DEFAULT_DB_PATH } from "../server/store/seed.ts";

const OPTS = { orgId: "org-1", userIds: ["u1", "u2", "u3"], requests: 300, now: 1_790_000_000_000 };

test("the same seed produces the same data on every machine", () => {
  const a = generateRecords({ ...OPTS, seed: 42 });
  const b = generateRecords({ ...OPTS, seed: 42 });
  assert.deepEqual(
    a.map((r) => ({ ...r, id: "" })),
    b.map((r) => ({ ...r, id: "" })),
    "a screenshot of the demo must mean the same thing to everyone",
  );
});

test("a subscription row carries no dollar cost — null, never zero", () => {
  const rows = generateRecords(OPTS).filter((r) => r.costBasis === "subscription");
  assert.ok(rows.length > 0, "the demo must exercise the subscription path");
  for (const row of rows) {
    assert.equal(row.costUsd, null);
    assert.equal(row.credentialOrigin, "inbound_subscription");
  }
});

test("the demo exercises the cases the UI exists to surface", () => {
  const rows = generateRecords(OPTS);
  const has = (p: (r: (typeof rows)[number]) => boolean): boolean => rows.some(p);

  assert.ok(has((r) => r.userId === null), "unattributed traffic");
  assert.ok(has((r) => r.credentialOrigin === "fallback_server"), "server-key substitution");
  assert.ok(has((r) => r.status !== "ok"), "failures");
  assert.ok(has((r) => r.httpStatus === 401), "a 401, which is expected traffic not a fault");
  assert.ok(has((r) => r.servedModel === null), "an unresolved model");
  assert.ok(has((r) => r.usage.cacheWrite1hTokens > 0), "1-hour cache writes");
});

test("records are ordered oldest first, so rowids run with time", () => {
  const rows = generateRecords(OPTS);
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok((rows[i]?.startedAt ?? 0) >= (rows[i - 1]?.startedAt ?? 0));
  }
});

test("token buckets stay disjoint and non-negative", () => {
  for (const r of generateRecords(OPTS)) {
    for (const v of Object.values(r.usage)) {
      if (typeof v === "number") assert.ok(v >= 0 && Number.isFinite(v));
    }
  }
});

test("the default database is recognised however its path is spelled", () => {
  // The wipe guard hangs off this. A guard you can step around by writing the
  // path differently is not a guard.
  for (const spelling of [DEFAULT_DB_PATH, "data/fest.db", "./data/./fest.db", "./data/../data/fest.db"]) {
    assert.equal(isDefaultDatabase(spelling), true, spelling);
  }
  for (const other of ["./data/demo.db", "./data/scratch.db", "/tmp/fest.db"]) {
    assert.equal(isDefaultDatabase(other), false, other);
  }
});
