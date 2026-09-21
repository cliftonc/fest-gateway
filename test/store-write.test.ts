import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, migrate } from "../server/store/db.ts";
import type { Store } from "../server/store/db.ts";
import { createRequestWriter, hourStart, latencyBucket } from "../server/store/write.ts";
import { newId } from "../server/store/ids.ts";
import { EMPTY_USAGE } from "../shared/types.ts";
import type { UsageRecord } from "../shared/types.ts";

// On-disk rather than :memory: — WAL is a no-op for an in-memory database, and
// the pragma path is part of what these tests are covering.
function freshStore(t: { after(fn: () => void): void }): Store {
  const dir = mkdtempSync(join(tmpdir(), "fest-store-"));
  const store = openStore(join(dir, "fest.db"));
  t.after(() => {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

let seq = 0;

interface RecOverrides {
  readonly userId?: string | null;
  readonly tokenId?: string | null;
  readonly [key: string]: unknown;
}

function rec(over: RecOverrides = {}): UsageRecord {
  seq += 1;
  const base = {
    id: `req_${seq}`,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_500,
    posture: "subscription",
    identityCarrier: "path",
    callerFingerprint: "caller00",
    credentialFingerprint: "cred0000",
    credentialOrigin: "inbound_subscription",
    sessionId: "sess-1",
    requestedModel: "claude-opus-5",
    servedModel: "claude-opus-5",
    upstream: "anthropic",
    stream: true,
    status: "ok",
    httpStatus: 200,
    partial: false,
    usage: EMPTY_USAGE,
    costUsd: null,
    costBasis: "subscription",
    ttfbMs: 120,
    durationMs: 500,
    bytesIn: 10,
    bytesOut: 20,
    upstreamRequestId: "upstream_1",
    rateLimit: null,
    clientVersion: "claude-cli/2.1.278",
  };
  return { ...base, ...over } as unknown as UsageRecord;
}

function usage(over: Partial<Record<string, unknown>> = {}) {
  return { ...EMPTY_USAGE, ...over };
}

const TOKEN_COLUMNS = [
  "input_tokens",
  "cache_read_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
  "output_tokens",
  "web_searches",
] as const;

function num(value: unknown): number {
  return Number(value ?? 0);
}

test("open sets WAL and the rest of the pragmas", (t) => {
  const store = freshStore(t);
  const mode = store.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  assert.equal(mode.journal_mode, "wal");
  const fk = store.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  assert.equal(Number(fk.foreign_keys), 1);
});

test("transaction rolls back on throw and is not re-entrant", (t) => {
  const store = freshStore(t);
  migrate(store);

  assert.throws(() => {
    store.transaction(() => {
      store.db.exec("INSERT INTO orgs (id, slug, name, created_at) VALUES ('org_x','x','X',1)");
      throw new Error("boom");
    });
  }, /boom/);

  const count = store.db.prepare("SELECT COUNT(*) AS n FROM orgs").get() as { n: number };
  assert.equal(num(count.n), 0);

  // A second transaction still works after the rollback.
  store.transaction(() => {
    store.db.exec("INSERT INTO orgs (id, slug, name, created_at) VALUES ('org_y','y','Y',1)");
  });
  const after = store.db.prepare("SELECT COUNT(*) AS n FROM orgs").get() as { n: number };
  assert.equal(num(after.n), 1);

  assert.throws(
    () => store.transaction(() => store.transaction(() => 1)),
    /not re-entrant/,
  );
});

test("newId is prefixed and unique", () => {
  const a = newId("org");
  const b = newId("org");
  assert.match(a, /^org_[0-9a-f]{32}$/);
  assert.notEqual(a, b);
  assert.match(newId("usr"), /^usr_/);
  assert.match(newId("tok"), /^tok_/);
});

test("hourStart and latencyBucket boundaries", () => {
  assert.equal(hourStart(3_600_000), 3_600_000);
  assert.equal(hourStart(3_600_001), 3_600_000);
  assert.equal(hourStart(7_199_999), 3_600_000);
  assert.equal(hourStart(7_200_000), 7_200_000);

  assert.equal(latencyBucket(0), 0);
  assert.equal(latencyBucket(999), 0);
  assert.equal(latencyBucket(1_000), 1);
  assert.equal(latencyBucket(2_999), 1);
  assert.equal(latencyBucket(3_000), 2);
  assert.equal(latencyBucket(9_999), 2);
  assert.equal(latencyBucket(10_000), 3);
  assert.equal(latencyBucket(29_999), 3);
  assert.equal(latencyBucket(30_000), 4);
  assert.equal(latencyBucket(59_999), 4);
  assert.equal(latencyBucket(60_000), 5);
  assert.equal(latencyBucket(600_000), 5);
});

test("a single record round-trips every requests column", (t) => {
  const store = freshStore(t);
  migrate(store);
  const writer = createRequestWriter(store);

  const record = rec({
    id: "req_roundtrip",
    userId: "usr_1",
    tokenId: "tok_1",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_004_000,
    posture: "key",
    identityCarrier: "header",
    credentialOrigin: "fallback_server",
    requestedModel: "claude-sonnet-5",
    servedModel: "claude-opus-5",
    stream: false,
    status: "upstream_error",
    httpStatus: 529,
    errorType: "overloaded_error",
    errorMessage: "Overloaded",
    partial: true,
    usage: usage({
      inputTokens: 11,
      cacheReadTokens: 22,
      cacheWrite5mTokens: 33,
      cacheWrite1hTokens: 44,
      outputTokens: 55,
      webSearches: 2,
      serviceTier: "standard",
    }),
    costUsd: 1.25,
    costBasis: "list",
    ttfbMs: 321,
    durationMs: 4_000,
    bytesIn: 1_234,
    bytesOut: 5_678,
    rateLimit: {
      status: "allowed",
      fiveHourUtilization: 0.42,
      fiveHourStatus: "allowed",
      fiveHourResetAt: 1_700_000_100_000,
      sevenDayUtilization: 0.07,
      sevenDayStatus: "allowed",
      sevenDayResetAt: 1_700_600_000_000,
      representativeClaim: "5h",
      overageStatus: "disabled",
      overageDisabledReason: "org_policy",
    },
  });

  assert.equal(writer.writeBatch("org_1", [record]), 1);

  const row = store.db.prepare("SELECT * FROM requests WHERE id = ?").get("req_roundtrip") as
    | Record<string, unknown>
    | undefined;
  assert.ok(row);

  assert.equal(row.org_id, "org_1");
  assert.equal(row.user_id, "usr_1");
  assert.equal(row.token_id, "tok_1");
  assert.equal(num(row.started_at), 1_700_000_000_000);
  assert.equal(num(row.ended_at), 1_700_000_004_000);
  assert.equal(row.posture, "key");
  assert.equal(row.identity_carrier, "header");
  assert.equal(row.caller_fingerprint, "caller00");
  assert.equal(row.credential_fingerprint, "cred0000");
  assert.equal(row.credential_origin, "fallback_server");
  assert.equal(row.session_id, "sess-1");
  assert.equal(row.requested_model, "claude-sonnet-5");
  assert.equal(row.served_model, "claude-opus-5");
  assert.equal(row.upstream, "anthropic");
  // Booleans are 0/1.
  assert.equal(num(row.stream), 0);
  assert.equal(num(row.partial), 1);
  assert.equal(row.status, "upstream_error");
  assert.equal(num(row.http_status), 529);
  assert.equal(row.error_type, "overloaded_error");
  assert.equal(row.error_message, "Overloaded");

  // Token buckets, disjoint and unmerged.
  assert.equal(num(row.input_tokens), 11);
  assert.equal(num(row.cache_read_tokens), 22);
  assert.equal(num(row.cache_write_5m_tokens), 33);
  assert.equal(num(row.cache_write_1h_tokens), 44);
  assert.equal(num(row.output_tokens), 55);
  assert.equal(num(row.web_searches), 2);
  assert.equal(row.service_tier, "standard");

  assert.equal(row.cost_usd, 1.25);
  assert.equal(row.cost_basis, "list");

  assert.equal(num(row.ttfb_ms), 321);
  assert.equal(num(row.duration_ms), 4_000);
  assert.equal(num(row.bytes_in), 1_234);
  assert.equal(num(row.bytes_out), 5_678);
  assert.equal(row.upstream_request_id, "upstream_1");

  // Flattened quota columns.
  assert.equal(row.rl_status, "allowed");
  assert.equal(row.rl_5h_utilization, 0.42);
  assert.equal(row.rl_5h_status, "allowed");
  assert.equal(num(row.rl_5h_reset_at), 1_700_000_100_000);
  assert.equal(row.rl_7d_utilization, 0.07);
  assert.equal(row.rl_7d_status, "allowed");
  assert.equal(num(row.rl_7d_reset_at), 1_700_600_000_000);
  assert.equal(row.rl_claim, "5h");
  assert.equal(row.rl_overage_status, "disabled");
  assert.equal(row.rl_overage_reason, "org_policy");
  assert.equal(row.client_version, "claude-cli/2.1.278");
});

test("optional fields and a null rateLimit become SQL NULL", (t) => {
  const store = freshStore(t);
  migrate(store);
  const writer = createRequestWriter(store);

  // No userId/tokenId: recorded as unattributed, not dropped.
  assert.equal(writer.writeBatch("org_1", [rec({ id: "req_null", rateLimit: null })]), 1);
  const row = store.db.prepare("SELECT * FROM requests WHERE id = ?").get("req_null") as Record<
    string,
    unknown
  >;
  assert.equal(row.user_id, null);
  assert.equal(row.token_id, null);
  assert.equal(row.cost_usd, null);
  assert.equal(row.error_type, null);
  assert.equal(row.error_message, null);
  assert.equal(row.service_tier, null);
  assert.equal(row.rl_status, null);
  assert.equal(row.rl_5h_utilization, null);
  assert.equal(row.rl_claim, null);
});

test("rollup ('','') totals equal the raw requests totals for every token column", (t) => {
  const store = freshStore(t);
  migrate(store);
  const writer = createRequestWriter(store);

  const batch: UsageRecord[] = [
    rec({
      userId: "usr_a",
      servedModel: "claude-opus-5",
      posture: "subscription",
      credentialOrigin: "inbound_subscription",
      costBasis: "subscription",
      usage: usage({ inputTokens: 100, cacheReadTokens: 2_000, outputTokens: 50, webSearches: 1 }),
      durationMs: 1_500,
      ttfbMs: 100,
    }),
    rec({
      userId: "usr_a",
      servedModel: "claude-haiku-5",
      posture: "key",
      credentialOrigin: "inbound_key",
      costUsd: 0.02,
      costBasis: "list",
      usage: usage({ inputTokens: 7, cacheWrite5mTokens: 900, outputTokens: 11 }),
      durationMs: 400,
      ttfbMs: null,
    }),
    rec({
      userId: "usr_b",
      servedModel: "claude-opus-5",
      posture: "key",
      credentialOrigin: "fallback_server",
      costUsd: 0.5,
      costBasis: "list",
      usage: usage({ inputTokens: 3, cacheWrite1hTokens: 12, outputTokens: 9, webSearches: 4 }),
      durationMs: 12_000,
      ttfbMs: 900,
      status: "stream_error",
    }),
    // Unattributed and unknown model: exercises the '' key de-duplication.
    rec({
      servedModel: null,
      usage: usage({ inputTokens: 1, outputTokens: 1 }),
      durationMs: 70_000,
    }),
  ];

  assert.equal(writer.writeBatch("org_1", batch), 4);

  for (const column of TOKEN_COLUMNS) {
    const raw = store.db
      .prepare(`SELECT COALESCE(SUM(${column}), 0) AS n FROM requests WHERE org_id = 'org_1'`)
      .get() as { n: number };
    const rolled = store.db
      .prepare(
        `SELECT COALESCE(SUM(${column}), 0) AS n FROM usage_hourly
         WHERE org_id = 'org_1' AND user_id = '' AND served_model = ''`,
      )
      .get() as { n: number };
    assert.equal(num(rolled.n), num(raw.n), `rollup disagrees with raw rows for ${column}`);
  }

  const rawCount = store.db.prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number };
  const rolledCount = store.db
    .prepare(
      "SELECT COALESCE(SUM(requests), 0) AS n FROM usage_hourly WHERE user_id = '' AND served_model = ''",
    )
    .get() as { n: number };
  assert.equal(num(rolledCount.n), num(rawCount.n));

  const errors = store.db
    .prepare(
      "SELECT COALESCE(SUM(errors), 0) AS n FROM usage_hourly WHERE user_id = '' AND served_model = ''",
    )
    .get() as { n: number };
  assert.equal(num(errors.n), 1);

  // Per-user bucket for usr_a, all models.
  const userA = store.db
    .prepare(
      `SELECT COALESCE(SUM(requests), 0) AS n, COALESCE(SUM(output_tokens), 0) AS o
       FROM usage_hourly WHERE user_id = 'usr_a' AND served_model = ''`,
    )
    .get() as { n: number; o: number };
  assert.equal(num(userA.n), 2);
  assert.equal(num(userA.o), 61);

  // All users, one model.
  const opus = store.db
    .prepare(
      `SELECT COALESCE(SUM(requests), 0) AS n FROM usage_hourly
       WHERE user_id = '' AND served_model = 'claude-opus-5'`,
    )
    .get() as { n: number };
  assert.equal(num(opus.n), 2);
});

test("cost honesty: priced, subscription and unpriced stay separate", (t) => {
  const store = freshStore(t);
  migrate(store);
  const writer = createRequestWriter(store);

  const written = writer.writeBatch("org_1", [
    rec({ userId: "usr_a", costUsd: 0.5, costBasis: "list" }),
    rec({ userId: "usr_a", costUsd: null, costBasis: "subscription" }),
    rec({ userId: "usr_a", costUsd: null, costBasis: "none" }),
  ]);
  assert.equal(written, 3);

  const totals = store.db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost,
              COALESCE(SUM(unpriced_requests), 0) AS unpriced,
              COALESCE(SUM(subscription_requests), 0) AS subs
       FROM usage_hourly WHERE org_id = 'org_1' AND user_id = '' AND served_model = ''`,
    )
    .get() as { cost: number; unpriced: number; subs: number };

  // A subscription request is real usage with NO org spend; an unknown model is
  // unpriced, not free. Neither may ever be summed into dollars as zero.
  assert.equal(totals.cost, 0.5);
  assert.equal(num(totals.unpriced), 1);
  assert.equal(num(totals.subs), 1);
});

test("two batches in the same hour accumulate rather than replace", (t) => {
  const store = freshStore(t);
  migrate(store);
  const writer = createRequestWriter(store);

  const at = 1_700_000_000_000;
  writer.writeBatch("org_1", [
    rec({ startedAt: at, userId: "usr_a", usage: usage({ inputTokens: 10, outputTokens: 1 }) }),
  ]);
  writer.writeBatch("org_1", [
    rec({
      startedAt: at + 60_000,
      userId: "usr_a",
      usage: usage({ inputTokens: 5, outputTokens: 2 }),
      durationMs: 2_000,
    }),
  ]);

  const rows = store.db
    .prepare(
      "SELECT * FROM usage_hourly WHERE user_id = '' AND served_model = ''",
    )
    .all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1, "same hour + same origin/basis must share one rollup row");
  const row = rows[0];
  assert.ok(row);
  assert.equal(num(row.requests), 2);
  assert.equal(num(row.input_tokens), 15);
  assert.equal(num(row.output_tokens), 3);
  assert.equal(num(row.duration_ms_sum), 2_500);
  // MAX, not last-write-wins.
  assert.equal(num(row.duration_ms_max), 2_000);
});

test("records in different hours land in different rollup rows", (t) => {
  const store = freshStore(t);
  migrate(store);
  const writer = createRequestWriter(store);

  const h0 = hourStart(1_700_000_000_000);
  writer.writeBatch("org_1", [
    rec({ startedAt: h0 + 10, userId: "usr_a" }),
    rec({ startedAt: h0 + 3_600_000 + 10, userId: "usr_a" }),
  ]);

  const rows = store.db
    .prepare(
      `SELECT hour_start, requests FROM usage_hourly
       WHERE user_id = '' AND served_model = '' ORDER BY hour_start`,
    )
    .all() as Array<{ hour_start: number; requests: number }>;
  assert.equal(rows.length, 2);
  assert.equal(num(rows[0]?.hour_start), h0);
  assert.equal(num(rows[1]?.hour_start), h0 + 3_600_000);
  assert.equal(num(rows[0]?.requests), 1);
  assert.equal(num(rows[1]?.requests), 1);
});

test("latency buckets: 999, 1000, 59999 and 60000 land in 0, 1, 4, 5", (t) => {
  const store = freshStore(t);
  migrate(store);
  const writer = createRequestWriter(store);

  writer.writeBatch("org_1", [
    rec({ durationMs: 999 }),
    rec({ durationMs: 1_000 }),
    rec({ durationMs: 59_999 }),
    rec({ durationMs: 60_000 }),
  ]);

  const row = store.db
    .prepare(
      `SELECT COALESCE(SUM(lat_b0),0) b0, COALESCE(SUM(lat_b1),0) b1, COALESCE(SUM(lat_b2),0) b2,
              COALESCE(SUM(lat_b3),0) b3, COALESCE(SUM(lat_b4),0) b4, COALESCE(SUM(lat_b5),0) b5
       FROM usage_hourly WHERE user_id = '' AND served_model = ''`,
    )
    .get() as Record<string, number>;

  assert.equal(num(row.b0), 1);
  assert.equal(num(row.b1), 1);
  assert.equal(num(row.b2), 0);
  assert.equal(num(row.b3), 0);
  assert.equal(num(row.b4), 1);
  assert.equal(num(row.b5), 1);
});

test("ttfb_count only counts records that actually had a first byte", (t) => {
  const store = freshStore(t);
  migrate(store);
  const writer = createRequestWriter(store);

  writer.writeBatch("org_1", [
    rec({ ttfbMs: 100 }),
    rec({ ttfbMs: 300 }),
    rec({ ttfbMs: null }),
    rec({ ttfbMs: null }),
  ]);

  const row = store.db
    .prepare(
      `SELECT COALESCE(SUM(ttfb_ms_sum),0) s, COALESCE(SUM(ttfb_count),0) c, COALESCE(SUM(requests),0) n
       FROM usage_hourly WHERE user_id = '' AND served_model = ''`,
    )
    .get() as { s: number; c: number; n: number };

  assert.equal(num(row.n), 4);
  assert.equal(num(row.c), 2);
  assert.equal(num(row.s), 400);
});

test("a malformed record is skipped and the rest of the batch still writes", (t) => {
  const store = freshStore(t);
  migrate(store);
  const writer = createRequestWriter(store);

  // `usage` missing entirely — reading its token buckets throws.
  const broken = { ...rec({ id: "req_broken" }), usage: undefined } as unknown as UsageRecord;

  let written = -1;
  assert.doesNotThrow(() => {
    written = writer.writeBatch("org_1", [rec({ id: "req_good_1" }), broken, rec({ id: "req_good_2" })]);
  });
  assert.equal(written, 2);

  const ids = (
    store.db.prepare("SELECT id FROM requests ORDER BY id").all() as Array<{ id: string }>
  ).map((r) => r.id);
  assert.deepEqual(ids, ["req_good_1", "req_good_2"]);

  // The skipped record left no rollup contribution either.
  const n = store.db
    .prepare(
      "SELECT COALESCE(SUM(requests),0) AS n FROM usage_hourly WHERE user_id = '' AND served_model = ''",
    )
    .get() as { n: number };
  assert.equal(num(n.n), 2);
});

test("an empty batch is a no-op", (t) => {
  const store = freshStore(t);
  migrate(store);
  const writer = createRequestWriter(store);
  assert.equal(writer.writeBatch("org_1", []), 0);
});

test("the feed query uses requests_feed and never scans the hot table", (t) => {
  const store = freshStore(t);
  migrate(store);

  const plan = (
    store.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT seq, id, started_at, served_model, status
         FROM requests WHERE org_id = ? AND started_at < ?
         ORDER BY started_at DESC LIMIT 100`,
      )
      .all() as Array<{ detail: string }>
  )
    .map((r) => r.detail)
    .join("\n");

  assert.match(plan, /requests_feed/, `plan did not use requests_feed:\n${plan}`);
  assert.doesNotMatch(plan, /SCAN requests/, `plan scans the hot table:\n${plan}`);
});
