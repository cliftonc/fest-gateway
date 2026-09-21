/**
 * Cost-honesty regression guards for the rollup write path.
 *
 * These exist because every failure mode here is silent: the dashboard shows a
 * confident number that is quietly wrong, and nobody investigates a number
 * that looks fine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, migrate } from "../server/store/db.ts";
import { createRequestWriter } from "../server/store/write.ts";
import { ensureOrg } from "../server/store/bootstrap.ts";
import { EMPTY_USAGE } from "../shared/types.ts";
import type { UsageRecord, CostBasis } from "../shared/types.ts";

function rec(over: Partial<UsageRecord>): UsageRecord {
  return {
    id: `req_${Math.random().toString(16).slice(2)}`,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    posture: "subscription",
    identityCarrier: "path",
    callerFingerprint: "fp",
    userId: "usr_1",
    tokenId: "tok_1",
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
    ttfbMs: 100,
    durationMs: 1000,
    bytesIn: 1,
    bytesOut: 2,
    upstreamRequestId: "rid",
    rateLimit: null,
    clientVersion: "claude-cli/2.1.278",
    ...over,
  };
}

function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "fest-honesty-"));
  const store = openStore(join(dir, "f.db"));
  migrate(store);
  const org = ensureOrg(store);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, orgId: org.id, writer: createRequestWriter(store) };
}

/** The ('','') bucket is many rows — one per (credential_origin, cost_basis). */
function orgTotals(store: any, orgId: string) {
  return store.db
    .prepare(
      `SELECT sum(requests) AS requests, sum(cost_usd) AS cost,
              sum(unpriced_requests) AS unpriced, sum(subscription_requests) AS subs,
              sum(input_tokens) AS input, sum(output_tokens) AS output
         FROM usage_hourly WHERE org_id = ? AND user_id = '' AND served_model = ''`,
    )
    .get(orgId) as Record<string, number | null>;
}

test("a non-finite cost is counted as unpriced, not silently dropped", (t) => {
  const { store, orgId, writer } = setup(t);
  writer.writeBatch(orgId, [
    rec({ costUsd: Number.NaN, costBasis: "list", credentialOrigin: "inbound_key", posture: "key" }),
  ]);

  const totals = orgTotals(store, orgId);
  // Excluded from the dollar sum...
  assert.equal(totals["cost"], 0);
  // ...but it must still show up as "n/a", or it vanishes from the books.
  assert.equal(totals["unpriced"], 1);
  assert.equal(totals["subs"], 0);
});

test("subscription usage is never counted as dollar spend nor as unpriced", (t) => {
  const { store, orgId, writer } = setup(t);
  writer.writeBatch(orgId, [
    rec({ costUsd: 0.5, costBasis: "list", credentialOrigin: "inbound_key", posture: "key" }),
    rec({ costUsd: null, costBasis: "subscription" }),
    rec({ costUsd: null, costBasis: "none", credentialOrigin: "inbound_key", posture: "key" }),
  ]);

  const totals = orgTotals(store, orgId);
  // Only the genuinely priced row contributes dollars. A subscription request
  // is real usage with no org spend; treating it as $0 spend would be a lie
  // in the other direction.
  assert.equal(totals["cost"], 0.5);
  assert.equal(totals["subs"], 1);
  assert.equal(totals["unpriced"], 1);
  assert.equal(totals["requests"], 3);
});

test("an unattributed request on an unknown model does not multiply org totals", (t) => {
  const { store, orgId, writer } = setup(t);
  // Both rollup dimensions fall back to the '' sentinel, so all four candidate
  // keys collapse onto ('',''). Without de-duplication the upsert would add
  // this record's tokens up to four times.
  writer.writeBatch(orgId, [
    rec({
      userId: null,
      tokenId: null,
      servedModel: null,
      requestedModel: null,
      status: "identity_denied",
      usage: { ...EMPTY_USAGE, inputTokens: 7, outputTokens: 3 },
    }),
  ]);

  const totals = orgTotals(store, orgId);
  assert.equal(totals["input"], 7);
  assert.equal(totals["output"], 3);
  assert.equal(totals["requests"], 1);
});

test("rollups always equal raw rows for a mixed batch", (t) => {
  const { store, orgId, writer } = setup(t);
  writer.writeBatch(orgId, [
    rec({ userId: "usr_a", servedModel: "claude-opus-5", usage: { ...EMPTY_USAGE, inputTokens: 1, cacheReadTokens: 100 } }),
    rec({ userId: "usr_b", servedModel: "claude-haiku-4-5", usage: { ...EMPTY_USAGE, inputTokens: 2, cacheReadTokens: 200 } }),
    rec({ userId: null, servedModel: null, status: "upstream_error", usage: { ...EMPTY_USAGE, inputTokens: 4 } }),
    rec({ userId: "usr_a", servedModel: null, usage: { ...EMPTY_USAGE, inputTokens: 8 } }),
  ]);

  const raw = store.db
    .prepare(
      `SELECT count(*) AS requests, sum(input_tokens) AS input, sum(cache_read_tokens) AS cacheRead
         FROM requests WHERE org_id = ?`,
    )
    .get(orgId) as Record<string, number>;
  const totals = orgTotals(store, orgId);

  assert.equal(totals["requests"], raw["requests"]);
  assert.equal(totals["input"], raw["input"]);
  assert.equal(Number(totals["output"] ?? 0) >= 0, true);
  const rolledCacheRead = store.db
    .prepare(
      `SELECT sum(cache_read_tokens) AS c FROM usage_hourly
        WHERE org_id = ? AND user_id = '' AND served_model = ''`,
    )
    .get(orgId) as { c: number | null };
  assert.equal(rolledCacheRead.c, raw["cacheRead"]);
});
