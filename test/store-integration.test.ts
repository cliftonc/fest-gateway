/**
 * Write/read coupling guard.
 *
 * The rollup cube overloads `''` on both `user_id` and `served_model`: it means
 * both "all" and "not attributed / never resolved". The read layer recovers
 * unattributed usage as a residual (org total minus attributed rows), and that
 * arithmetic is only correct because the writer de-duplicates its four
 * candidate rollup keys before upserting.
 *
 * That is a load-bearing dependency between two files with nothing enforcing
 * it. So these tests populate via the REAL writer and read via the REAL query
 * layer — no hand-seeded cube — which is the only way a regression in either
 * half gets caught.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, migrate } from "../server/store/db.ts";
import type { Store } from "../server/store/db.ts";
import { createRequestWriter } from "../server/store/write.ts";
import { ensureOrg, ensureUser } from "../server/store/bootstrap.ts";
import {
  usageTotals,
  usageByUser,
  usageByModel,
  usageByTag,
  listRequests,
} from "../server/store/queries.ts";
import { runRetention } from "../server/store/retention.ts";
import type { Scope } from "../server/store/queries.ts";
import { EMPTY_USAGE } from "../shared/types.ts";
import type { UsageRecord } from "../shared/types.ts";

const NOW = 1_800_000_000_000;

function rec(over: Partial<UsageRecord>): UsageRecord {
  return {
    id: `req_${Math.random().toString(16).slice(2)}`,
    startedAt: NOW,
    endedAt: NOW + 1000,
    posture: "subscription",
    identityCarrier: "path",
    callerFingerprint: "fp",
    userId: null,
    tokenId: null,
    credentialFingerprint: "cfp",
    credentialOrigin: "inbound_subscription",
    sessionId: "sess",
    requestedModel: "claude-opus-5",
    servedModel: "claude-opus-5",
    upstream: "https://api.anthropic.com",
    stream: true,
    status: "ok",
    httpStatus: 200,
    partial: false,
    usage: { ...EMPTY_USAGE, inputTokens: 10, outputTokens: 5 },
    costUsd: null,
    costBasis: "subscription",
    notionalCostUsd: null,
    ttfbMs: 100,
    durationMs: 1000,
    bytesIn: 1,
    bytesOut: 2,
    upstreamRequestId: "rid",
    rateLimit: null,
    clientVersion: "claude-cli/2.1.278",
    pipeline: "passthrough",
    routeId: null,
    credentialsConsidered: [{ source: "inbound_subscription", result: "used" }],
    ...over,
  };
}

function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "fest-int-"));
  const store: Store = openStore(join(dir, "f.db"));
  migrate(store);
  const org = ensureOrg(store);
  const alice = ensureUser(store, { orgId: org.id, email: "alice@corp.test" });
  const bob = ensureUser(store, { orgId: org.id, email: "bob@corp.test" });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const scope: Scope = { orgId: org.id, role: "admin" };
  return { store, orgId: org.id, scope, alice, bob, writer: createRequestWriter(store) };
}

/** Long range forces the rollup path; short range forces raw rows. */
const LONG = { fromMs: NOW - 30 * 86_400_000, toMs: NOW + 86_400_000 };
const SHORT = { fromMs: NOW - 60_000, toMs: NOW + 60_000 };

test("rollup path and raw path agree on totals written by the real writer", (t) => {
  const { store, orgId, scope, alice, bob, writer } = setup(t);

  writer.writeBatch(orgId, [
    rec({ userId: alice.id, tokenId: "tok_a", servedModel: "claude-opus-5" }),
    rec({ userId: bob.id, tokenId: "tok_b", servedModel: "claude-haiku-4-5" }),
    // Unattributed and model never resolved: the case where all four candidate
    // rollup keys collapse onto ('','').
    rec({ userId: null, servedModel: null, requestedModel: null, status: "identity_denied" }),
  ]);

  const viaRollup = usageTotals(store, scope, LONG);
  const viaRaw = usageTotals(store, scope, SHORT);

  assert.equal(viaRollup.requests, 3, "rollup must count each request exactly once");
  assert.equal(viaRaw.requests, 3);
  // The whole point: no 4x multiplication from collapsed keys.
  assert.equal(viaRollup.usage.inputTokens, viaRaw.usage.inputTokens);
  assert.equal(viaRollup.usage.outputTokens, viaRaw.usage.outputTokens);
  assert.equal(viaRollup.usage.inputTokens, 30);
});

test("unattributed usage is visible, not swallowed, on both paths", (t) => {
  const { store, orgId, scope, alice, writer } = setup(t);
  writer.writeBatch(orgId, [
    rec({ userId: alice.id, usage: { ...EMPTY_USAGE, inputTokens: 100 } }),
    rec({ userId: null, usage: { ...EMPTY_USAGE, inputTokens: 7 } }),
  ]);

  for (const [label, range] of [["rollup", LONG], ["raw", SHORT]] as const) {
    const rows = usageByUser(store, scope, range);
    const total = rows.reduce((n, r) => n + r.usage.inputTokens, 0);
    // The breakdown must sum to the headline, or an admin is being shown a
    // number that quietly excludes requests nobody is accountable for.
    assert.equal(total, 107, `${label}: breakdown must sum to the total`);
    const unattributed = rows.find((r) => r.userId === "");
    assert.ok(unattributed !== undefined, `${label}: unattributed row must be present`);
    assert.equal(unattributed.usage.inputTokens, 7);
    assert.equal(unattributed.email, null);
  }
});

test("subscription usage is never rendered as dollar spend", (t) => {
  const { store, orgId, scope, alice, writer } = setup(t);
  writer.writeBatch(orgId, [
    rec({ userId: alice.id, costUsd: null, costBasis: "subscription" }),
    rec({
      userId: alice.id,
      costUsd: 0.25,
      costBasis: "list",
      posture: "key",
      credentialOrigin: "inbound_key",
    }),
    rec({ userId: alice.id, costUsd: null, costBasis: "none", posture: "key", credentialOrigin: "inbound_key" }),
  ]);

  for (const [label, range] of [["rollup", LONG], ["raw", SHORT]] as const) {
    const t2 = usageTotals(store, scope, range);
    // Only the genuinely priced row contributes dollars.
    assert.equal(t2.pricedCostUsd, 0.25, `${label}: priced total`);
    assert.equal(t2.subscriptionRequests, 1, `${label}: subscription counted separately`);
    assert.equal(t2.unpricedRequests, 1, `${label}: unpriced counted separately`);
  }
});

test("a model that never resolved is attributed to a visible bucket", (t) => {
  const { store, orgId, scope, alice, writer } = setup(t);
  writer.writeBatch(orgId, [
    rec({ userId: alice.id, servedModel: "claude-opus-5", usage: { ...EMPTY_USAGE, inputTokens: 50 } }),
    rec({ userId: alice.id, servedModel: null, status: "upstream_error", usage: { ...EMPTY_USAGE, inputTokens: 3 } }),
  ]);

  for (const [label, range] of [["rollup", LONG], ["raw", SHORT]] as const) {
    const rows = usageByModel(store, scope, range);
    const total = rows.reduce((n, r) => n + r.usage.inputTokens, 0);
    assert.equal(total, 53, `${label}: model breakdown must sum to the total`);
  }
});

test("the feed pages through real writer output exactly once per row", (t) => {
  const { store, orgId, scope, alice, writer } = setup(t);
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const r = rec({ userId: alice.id, startedAt: NOW + i });
    ids.push(r.id);
    writer.writeBatch(orgId, [r]);
  }

  const seen: string[] = [];
  let cursor: number | null | undefined = undefined;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = listRequests(store, scope, {
      limit: 2,
      ...(cursor === null || cursor === undefined ? {} : { beforeSeq: cursor }),
    });
    for (const row of page.rows) seen.push(row.id);
    cursor = page.nextCursor;
    if (cursor === null) break;
  }

  assert.equal(seen.length, 5, "every row seen exactly once");
  assert.equal(new Set(seen).size, 5, "no duplicates across pages");
  // Newest first.
  assert.deepEqual(seen, [...ids].reverse());
});

test("member scope cannot see another member's requests", (t) => {
  const { store, orgId, alice, bob, writer } = setup(t);
  writer.writeBatch(orgId, [
    rec({ userId: alice.id, usage: { ...EMPTY_USAGE, inputTokens: 11 } }),
    rec({ userId: bob.id, usage: { ...EMPTY_USAGE, inputTokens: 22 } }),
  ]);

  const asAlice: Scope = { orgId, role: "member", userId: alice.id };
  const feed = listRequests(store, asAlice, { limit: 50 });
  assert.equal(feed.rows.length, 1);
  assert.equal(feed.rows[0]?.userId, alice.id);
  assert.equal(usageTotals(store, asAlice, SHORT).usage.inputTokens, 11);
});

// ── Tags ─────────────────────────────────────────────────────────────────────
//
// Tags are a cube dimension (migration 007), keyed on the whole tag set. These
// prove the two properties that design rests on: a filter means the same thing
// on both sides of the 2h threshold, and "no filter" still adds up to exactly
// one count per request even though every tag set is its own row.

function seedTagged(t: any) {
  const ctx = setup(t);
  const { orgId, alice, bob, writer } = ctx;
  const tokens = (n: number) => ({ ...EMPTY_USAGE, inputTokens: n });
  writer.writeBatch(orgId, [
    rec({ userId: alice.id, tags: { team: "platform", project: "fest" }, usage: tokens(1) }),
    rec({ userId: alice.id, tags: { team: "platform", project: "web" }, usage: tokens(2) }),
    rec({ userId: bob.id, tags: { team: "data", project: "fest" }, usage: tokens(4) }),
    rec({ userId: bob.id, usage: tokens(8) }),
    // Unattributed and tagged: the residual has to survive filtering too.
    rec({ userId: null, tags: { project: "fest" }, usage: tokens(16) }),
  ]);
  return ctx;
}

test("a tag filter gives the same answer from raw rows and from the rollup", (t) => {
  const { store, scope } = seedTagged(t);
  const cases: Array<[Record<string, string> | undefined, number]> = [
    [undefined, 31],
    [{ project: "fest" }, 21],
    [{ team: "platform" }, 3],
    [{ team: "platform", project: "fest" }, 1],
    [{ team: "nobody" }, 0],
  ];
  for (const [tags, input] of cases) {
    for (const range of [SHORT, LONG]) {
      assert.equal(
        usageTotals(store, scope, { ...range, tags }).usage.inputTokens,
        input,
        `${JSON.stringify(tags)} over ${range === SHORT ? "raw" : "rollup"}`,
      );
    }
  }
});

test("per-tag rows add up to the total, untagged traffic included", (t) => {
  const { store, scope } = seedTagged(t);
  for (const range of [SHORT, LONG]) {
    const rows = usageByTag(store, scope, range, "project");
    assert.deepEqual(
      rows.map((r) => [r.value, r.usage.inputTokens]),
      // Most requests first; on a tie the untagged bucket sorts last.
      [
        ["fest", 21],
        ["web", 2],
        ["", 8],
      ],
    );
    const sum = rows.reduce((a, r) => a + r.requests, 0);
    assert.equal(sum, usageTotals(store, scope, range).requests);
  }
});

test("breakdowns honour the tag filter, including the unattributed residual", (t) => {
  const { store, scope, alice, bob } = seedTagged(t);
  for (const range of [SHORT, LONG]) {
    const users = usageByUser(store, scope, { ...range, tags: { project: "fest" } });
    const byId = new Map(users.map((u) => [u.userId, u.usage.inputTokens]));
    assert.equal(byId.get(alice.id), 1);
    assert.equal(byId.get(bob.id), 4);
    assert.equal(byId.get(""), 16, "unattributed tagged usage is a residual on the rollup");
    assert.equal(usageByModel(store, scope, { ...range, tags: { project: "web" } })[0]?.usage.inputTokens, 2);
  }
  const feed = listRequests(store, scope, { limit: 50, tags: { team: "platform" } });
  assert.equal(feed.rows.length, 2);
});

test("a member's tag filter only narrows their own traffic", (t) => {
  const { store, orgId, alice } = seedTagged(t);
  const asAlice: Scope = { orgId, role: "member", userId: alice.id };
  for (const range of [SHORT, LONG]) {
    assert.equal(usageTotals(store, asAlice, { ...range, tags: { project: "fest" } }).usage.inputTokens, 1);
    assert.deepEqual(
      usageByTag(store, asAlice, range, "project").map((r) => r.value),
      ["fest", "web"],
    );
  }
});

test("tag filters keep working after retention deletes the raw rows", (t) => {
  const { store, scope } = seedTagged(t);
  runRetention(store, { requestDays: 1, rollupDays: 400 }, NOW + 10 * 86_400_000);
  assert.equal(listRequests(store, scope, { limit: 50 }).rows.length, 0, "raw rows are gone");
  assert.equal(usageTotals(store, scope, { ...LONG, tags: { project: "fest" } }).usage.inputTokens, 21);
});
