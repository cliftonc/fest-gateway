/**
 * Read-layer tests.
 *
 * Rows are seeded with raw SQL local to this file rather than through
 * server/store/write.ts on purpose: these tests are the contract for the QUERY
 * side, and if they went through the writer a bug in the writer would make them
 * fail and a bug in the writer's *semantics* would make them pass. The rollup
 * upsert below deliberately mirrors the writer's four-key, de-duplicated cube
 * (see the cube note in server/store/queries.ts) — that mirroring is itself
 * part of what is under test, because every rollup query depends on it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore, migrate, type Store } from "../server/store/db.ts";
import * as queries from "../server/store/queries.ts";
import {
  chooseSource,
  errorBreakdown,
  feedSql,
  interpolatePercentile,
  latencySummary,
  latestQuotaByUser,
  listRequests,
  usageByCredentialOrigin,
  usageByModel,
  usageByUser,
  usageByUserSql,
  usageSeries,
  usageTotals,
  RAW_WINDOW_MS,
  type Scope,
  type TimeRange,
} from "../server/store/queries.ts";

const HOUR = 3_600_000;
/** A fixed hour boundary, so bucketing is never off by a partial hour. */
const H = 1_700_000_000_000 - (1_700_000_000_000 % HOUR);

/** <= RAW_WINDOW_MS, so `chooseSource` reads raw `requests`. */
const SHORT: TimeRange = { fromMs: H, toMs: H + HOUR };
/** > RAW_WINDOW_MS, so `chooseSource` reads `usage_hourly`. */
const LONG: TimeRange = { fromMs: H - 24 * HOUR, toMs: H + HOUR };

function fresh(t: { after(fn: () => void): void }): Store {
  const dir = mkdtempSync(join(tmpdir(), "fest-queries-"));
  const store = openStore(join(dir, "test.db"));
  migrate(store);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

function seedOrg(store: Store, id: string): void {
  store.db
    .prepare("INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(id, id, id, H);
}

function seedUser(store: Store, orgId: string, id: string, email: string): void {
  store.db
    .prepare(
      "INSERT INTO users (id, org_id, email, role, created_at) VALUES (?, ?, ?, 'member', ?)",
    )
    .run(id, orgId, email, H);
}

interface Seed {
  readonly id: string;
  readonly userId?: string | null;
  readonly startedAt?: number;
  readonly sessionId?: string | null;
  readonly servedModel?: string | null;
  readonly credentialOrigin?: string;
  readonly status?: string;
  readonly errorType?: string | null;
  readonly httpStatus?: number | null;
  readonly costUsd?: number | null;
  readonly costBasis?: string;
  readonly notionalCostUsd?: number | null;
  readonly inputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly outputTokens?: number;
  readonly durationMs?: number;
  readonly ttfbMs?: number | null;
  readonly rl5h?: number | null;
  readonly rlClaim?: string | null;
  readonly clientVersion?: string | null;
  readonly credentialFingerprint?: string | null;
}

const INSERT_REQUEST = `INSERT INTO requests (
  id, org_id, user_id, started_at, ended_at, posture, identity_carrier,
  credential_fingerprint, credential_origin, session_id,
  requested_model, served_model, upstream, stream, status, http_status,
  error_type, partial, input_tokens, cache_read_tokens, output_tokens,
  cost_usd, cost_basis, notional_cost_usd, ttfb_ms, duration_ms,
  rl_status, rl_5h_utilization, rl_5h_status, rl_5h_reset_at,
  rl_7d_utilization, rl_claim, client_version
) VALUES (?, ?, ?, ?, ?, 'subscription', 'header', ?, ?, ?, ?, ?, 'api.anthropic.com',
  0, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const KEY_COLS = "org_id, hour_start, user_id, served_model, credential_origin, cost_basis";
const ADD_COLS = [
  "requests",
  "errors",
  "input_tokens",
  "cache_read_tokens",
  "output_tokens",
  "cost_usd",
  "unpriced_requests",
  "subscription_requests",
  "notional_cost_usd",
  "notional_unpriced_requests",
  "duration_ms_sum",
  "ttfb_ms_sum",
  "ttfb_count",
  "lat_b0",
  "lat_b1",
  "lat_b2",
  "lat_b3",
  "lat_b4",
  "lat_b5",
];
const UPSERT_ROLLUP = `INSERT INTO usage_hourly (${KEY_COLS}, ${ADD_COLS.join(", ")}, duration_ms_max)
  VALUES (${new Array(KEY_COLS.split(",").length + ADD_COLS.length + 1).fill("?").join(", ")})
  ON CONFLICT(${KEY_COLS}) DO UPDATE SET
  ${ADD_COLS.map((c) => `${c} = ${c} + excluded.${c}`).join(", ")},
  duration_ms_max = MAX(duration_ms_max, excluded.duration_ms_max)`;

function latBucket(ms: number): number {
  if (ms < 1000) return 0;
  if (ms < 3000) return 1;
  if (ms < 10_000) return 2;
  if (ms < 30_000) return 3;
  if (ms < 60_000) return 4;
  return 5;
}

/** Insert one raw row AND its four de-duplicated rollup cells. */
function seedRequest(store: Store, orgId: string, s: Seed): void {
  const startedAt = s.startedAt ?? H + 1000;
  const status = s.status ?? "ok";
  const durationMs = s.durationMs ?? 500;
  const costBasis = s.costBasis ?? "none";
  const costUsd = s.costUsd === undefined ? null : s.costUsd;
  const notionalCostUsd = s.notionalCostUsd === undefined ? null : s.notionalCostUsd;
  const inputTokens = s.inputTokens ?? 0;
  const cacheReadTokens = s.cacheReadTokens ?? 0;
  const outputTokens = s.outputTokens ?? 0;
  const ttfbMs = s.ttfbMs === undefined ? 100 : s.ttfbMs;
  const userId = s.userId === undefined ? null : s.userId;
  const servedModel = s.servedModel === undefined ? "claude-sonnet-4-5" : s.servedModel;
  const credentialOrigin = s.credentialOrigin ?? "inbound_subscription";

  store.db
    .prepare(INSERT_REQUEST)
    .run(
      s.id,
      orgId,
      userId,
      startedAt,
      startedAt + durationMs,
      s.credentialFingerprint ?? null,
      credentialOrigin,
      s.sessionId ?? null,
      servedModel,
      servedModel,
      status,
      s.httpStatus ?? null,
      s.errorType ?? null,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      costUsd,
      costBasis,
      notionalCostUsd,
      ttfbMs,
      durationMs,
      s.rl5h === null || s.rl5h === undefined ? null : "allowed",
      s.rl5h ?? null,
      s.rl5h === null || s.rl5h === undefined ? null : "allowed",
      s.rl5h === null || s.rl5h === undefined ? null : startedAt + HOUR,
      null,
      s.rlClaim ?? null,
      s.clientVersion ?? null,
    );

  const bucket = latBucket(durationMs);
  const priced = typeof costUsd === "number";
  const isSub = costBasis === "subscription";
  const additive = [
    1,
    status !== "ok" ? 1 : 0,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    priced && !isSub ? costUsd : 0,
    costUsd === null && !isSub ? 1 : 0,
    isSub ? 1 : 0,
    notionalCostUsd ?? 0,
    notionalCostUsd === null ? 1 : 0,
    durationMs,
    ttfbMs ?? 0,
    ttfbMs === null ? 0 : 1,
    ...[0, 1, 2, 3, 4, 5].map((b) => (b === bucket ? 1 : 0)),
  ];

  const u = userId ?? "";
  const m = servedModel ?? "";
  const seen = new Set<string>();
  for (const [ku, km] of [
    [u, m],
    [u, ""],
    ["", m],
    ["", ""],
  ] as Array<[string, string]>) {
    const key = `${ku}\u0000${km}`;
    if (seen.has(key)) continue;
    seen.add(key);
    store.db
      .prepare(UPSERT_ROLLUP)
      .run(
        orgId,
        Math.floor(startedAt / HOUR) * HOUR,
        ku,
        km,
        credentialOrigin,
        costBasis,
        ...additive,
        durationMs,
      );
  }
}

// ── The world: two orgs. Everything belonging to org B is marked "bbb". ──────

const ORG_A = "org_aaa";
const ORG_B = "org_bbb";
const U1 = "usr_aaa_one";
const U2 = "usr_aaa_two";
const ADMIN: Scope = { orgId: ORG_A, role: "admin" };
const MEMBER: Scope = { orgId: ORG_A, role: "member", userId: U1 };

function seedWorld(store: Store): void {
  seedOrg(store, ORG_A);
  seedOrg(store, ORG_B);
  seedUser(store, ORG_A, U1, "one@aaa.test");
  seedUser(store, ORG_A, U2, "two@aaa.test");
  seedUser(store, ORG_B, "usr_bbb", "bbb@bbb.test");

  seedRequest(store, ORG_A, {
    id: "req_a1",
    userId: U1,
    startedAt: H + 1000,
    sessionId: "sess_a1",
    costUsd: 1.5,
    costBasis: "list",
    inputTokens: 100,
    cacheReadTokens: 300,
    outputTokens: 50,
    rl5h: 0.4,
    rlClaim: "five_hour",
  });
  seedRequest(store, ORG_A, {
    id: "req_a2",
    userId: U2,
    startedAt: H + 2000,
    servedModel: "claude-opus-4-5",
    credentialOrigin: "inbound_key",
    costUsd: 2.5,
    costBasis: "list",
    inputTokens: 10,
    durationMs: 4000,
  });
  seedRequest(store, ORG_A, {
    id: "req_a3",
    userId: U1,
    startedAt: H + 3000,
    status: "upstream_error",
    errorType: "overloaded_error",
    httpStatus: 529,
    costBasis: "subscription",
  });
  // Unattributed: arrived with no identity token. Recorded, never dropped.
  seedRequest(store, ORG_A, { id: "req_a4", userId: null, startedAt: H + 4000, inputTokens: 7 });

  // Org B: every value distinctive so a leak is unmistakable.
  seedRequest(store, ORG_B, {
    id: "req_bbb_1",
    userId: "usr_bbb",
    startedAt: H + 1500,
    sessionId: "sess_bbb",
    servedModel: "model-bbb",
    credentialOrigin: "fallback_server",
    credentialFingerprint: "fp_bbb",
    clientVersion: "cli-bbb",
    status: "stream_error",
    errorType: "err_bbb",
    httpStatus: 599,
    costUsd: 999.5,
    costBasis: "list",
    inputTokens: 999_999,
    cacheReadTokens: 888_888,
    outputTokens: 777_777,
    durationMs: 99_999,
    ttfbMs: 4321,
    rl5h: 0.99,
    rlClaim: "claim_bbb",
  });
  seedRequest(store, ORG_B, {
    id: "req_bbb_2",
    userId: "usr_bbb",
    startedAt: H + 2500,
    servedModel: "model-bbb",
    credentialOrigin: "fallback_server",
    costBasis: "subscription",
  });
}

/** Every read entrypoint, driven as data so a new one cannot be forgotten. */
const ENTRYPOINTS: ReadonlyArray<{
  readonly name: string;
  readonly run: (store: Store, scope: Scope, range: TimeRange) => unknown;
}> = [
  { name: "listRequests", run: (s, sc) => listRequests(s, sc, { limit: 100 }) },
  { name: "usageTotals", run: (s, sc, r) => usageTotals(s, sc, r) },
  { name: "usageByUser", run: (s, sc, r) => usageByUser(s, sc, r) },
  { name: "usageByModel", run: (s, sc, r) => usageByModel(s, sc, r) },
  { name: "usageByCredentialOrigin", run: (s, sc, r) => usageByCredentialOrigin(s, sc, r) },
  { name: "usageSeries", run: (s, sc, r) => usageSeries(s, sc, r) },
  { name: "errorBreakdown", run: (s, sc, r) => errorBreakdown(s, sc, r) },
  { name: "latencySummary", run: (s, sc, r) => latencySummary(s, sc, r) },
  { name: "latestQuotaByUser", run: (s, sc) => latestQuotaByUser(s, sc) },
];

/** Exports that take no `Scope`, so tenancy does not apply to them. */
const PURE_HELPERS = new Set(["chooseSource", "interpolatePercentile", "feedSql", "usageByUserSql"]);

// ── Tenancy isolation: the test that matters most ────────────────────────────

test("every exported query is covered by the tenancy loop", () => {
  const exported = Object.entries(queries)
    .filter(([, v]) => typeof v === "function")
    .map(([k]) => k);
  const covered = new Set(ENTRYPOINTS.map((e) => e.name));
  const uncovered = exported.filter((n) => !covered.has(n) && !PURE_HELPERS.has(n));
  assert.deepEqual(
    uncovered,
    [],
    `new scoped query not covered by the tenancy test: ${uncovered.join(", ")}`,
  );
});

test("tenancy isolation: org A never sees org B data, on either source", (t) => {
  const store = fresh(t);
  seedWorld(store);

  for (const range of [SHORT, LONG]) {
    for (const entry of ENTRYPOINTS) {
      const json = JSON.stringify(entry.run(store, ADMIN, range));
      assert.ok(
        !json.includes("bbb"),
        `${entry.name} (${chooseSource(range)}) leaked org B: ${json}`,
      );
    }
  }

  // And the loop is not passing by returning nothing: org A's own data is there.
  for (const range of [SHORT, LONG]) {
    assert.equal(usageTotals(store, ADMIN, range).requests, 4, `totals via ${chooseSource(range)}`);
  }
  assert.equal(listRequests(store, ADMIN, { limit: 100 }).rows.length, 4);
  assert.equal(latestQuotaByUser(store, ADMIN).length, 1);

  // Symmetry: org B sees only its own two rows, so the filter is not simply
  // "hide everything unfamiliar".
  const bScope: Scope = { orgId: ORG_B, role: "admin" };
  assert.equal(usageTotals(store, bScope, SHORT).requests, 2);
  assert.equal(usageTotals(store, bScope, LONG).requests, 2);
  const bJson = JSON.stringify(listRequests(store, bScope, { limit: 100 }));
  assert.ok(!bJson.includes("req_a"), "org B saw org A requests");
});

// ── Member scoping ───────────────────────────────────────────────────────────

test("member scope sees only its own requests; admin sees all", (t) => {
  const store = fresh(t);
  seedWorld(store);

  const memberRows = listRequests(store, MEMBER, { limit: 100 }).rows;
  assert.deepEqual(
    memberRows.map((r) => r.id).sort(),
    ["req_a1", "req_a3"],
    "member saw rows that are not theirs",
  );
  for (const range of [SHORT, LONG]) {
    assert.equal(usageTotals(store, MEMBER, range).requests, 2, `member via ${chooseSource(range)}`);
    assert.equal(usageTotals(store, ADMIN, range).requests, 4, `admin via ${chooseSource(range)}`);
  }
  // A member's per-user breakdown is just themselves — and crucially does not
  // pick up the unattributed row, which is not provably theirs.
  const byUser = usageByUser(store, MEMBER, LONG);
  assert.deepEqual(byUser.map((r) => r.userId), [U1]);
  assert.equal(usageByUser(store, MEMBER, SHORT).length, 1);
  assert.equal(latestQuotaByUser(store, MEMBER).length, 1);
  assert.equal(errorBreakdown(store, MEMBER, SHORT).length, 1);
});

test("a member scope with no userId fails closed rather than widening", (t) => {
  const store = fresh(t);
  seedWorld(store);
  const broken: Scope = { orgId: ORG_A, role: "member" };
  assert.throws(() => usageTotals(store, broken, SHORT), /member scope requires a userId/);
  assert.throws(() => listRequests(store, broken, {}), /member scope requires a userId/);
});

// ── Cost honesty ─────────────────────────────────────────────────────────────

test("priced, subscription and unpriced rows are reported as three separate facts", (t) => {
  const store = fresh(t);
  seedOrg(store, ORG_A);
  seedUser(store, ORG_A, U1, "one@aaa.test");

  // 2 priced ($1.25 + $0.75), 3 subscription (real usage, NO org spend),
  // 1 unpriced (unknown model, not free).
  seedRequest(store, ORG_A, { id: "p1", userId: U1, costUsd: 1.25, costBasis: "list" });
  seedRequest(store, ORG_A, { id: "p2", userId: U1, costUsd: 0.75, costBasis: "list" });
  for (const id of ["s1", "s2", "s3"]) {
    seedRequest(store, ORG_A, { id, userId: U1, costBasis: "subscription" });
  }
  seedRequest(store, ORG_A, {
    id: "n1",
    userId: U1,
    servedModel: "some-unknown-model",
    costBasis: "none",
  });

  for (const range of [SHORT, LONG]) {
    const t2 = usageTotals(store, ADMIN, range);
    const via = chooseSource(range);
    assert.equal(t2.requests, 6, via);
    assert.ok(Math.abs(t2.pricedCostUsd - 2.0) < 1e-9, `${via}: ${t2.pricedCostUsd}`);
    assert.equal(t2.unpricedRequests, 1, via);
    assert.equal(t2.subscriptionRequests, 3, via);
  }

  // The load-bearing assertion: the subscription rows are NOT in the dollar
  // total, and are NOT silently counted as $0 spend either.
  const only = usageTotals(store, ADMIN, SHORT);
  assert.equal(only.pricedCostUsd, 2.0);
  assert.notEqual(only.requests, only.subscriptionRequests + 2 + 1 - 1);
  assert.equal(only.subscriptionRequests + only.unpricedRequests + 2, only.requests);

  // Removing the subscription rows must not change the dollar figure at all.
  store.db.prepare("DELETE FROM requests WHERE cost_basis = 'subscription'").run();
  assert.equal(usageTotals(store, ADMIN, SHORT).pricedCostUsd, 2.0);
});

// ── Keyset pagination ────────────────────────────────────────────────────────

test("keyset pagination walks every row exactly once in seq DESC order", (t) => {
  const store = fresh(t);
  seedOrg(store, ORG_A);
  seedUser(store, ORG_A, U1, "one@aaa.test");
  for (let i = 1; i <= 5; i += 1) {
    seedRequest(store, ORG_A, { id: `k${i}`, userId: U1, startedAt: H + i * 1000 });
  }

  const seen: number[] = [];
  const ids: string[] = [];
  let cursor: number | null | undefined = undefined;
  let pages = 0;
  for (;;) {
    const page = listRequests(store, ADMIN, {
      limit: 2,
      ...(cursor === null || cursor === undefined ? {} : { beforeSeq: cursor }),
    });
    pages += 1;
    for (const row of page.rows) {
      seen.push(row.seq);
      ids.push(row.id);
    }
    if (page.nextCursor === null) {
      cursor = null;
      break;
    }
    cursor = page.nextCursor;
    assert.ok(pages < 10, "pagination did not terminate");
  }

  assert.equal(cursor, null, "walk must finish with nextCursor === null");
  assert.equal(pages, 3, "5 rows at limit 2 should be 3 pages");
  assert.equal(new Set(seen).size, 5, "a row was returned twice or skipped");
  assert.deepEqual(ids, ["k5", "k4", "k3", "k2", "k1"]);
  assert.deepEqual([...seen].sort((a, b) => b - a), seen, "not in seq DESC order");
});

test("limit is coerced to an integer and clamped", (t) => {
  const store = fresh(t);
  seedOrg(store, ORG_A);
  for (let i = 0; i < 3; i += 1) seedRequest(store, ORG_A, { id: `c${i}` });

  // A query string can hand us anything; none of these may become "all rows"
  // or a SQL error.
  const hostile = [0, -1, 1.7, Number.NaN, 10 ** 9, Number.POSITIVE_INFINITY];
  for (const limit of hostile) {
    const { params } = feedSql(ADMIN, { limit });
    const bound = params[params.length - 1];
    assert.equal(typeof bound, "number");
    assert.ok(Number.isInteger(bound), `limit ${limit} bound as ${String(bound)}`);
    assert.ok((bound as number) >= 1 && (bound as number) <= queries.MAX_LIMIT);
  }
  assert.equal(listRequests(store, ADMIN, { limit: 1.7 }).rows.length, 1);
});

// ── Feed filters ─────────────────────────────────────────────────────────────

test("feed filters: user, model, credential origin, errorsOnly, session", (t) => {
  const store = fresh(t);
  seedWorld(store);
  const ids = (f: Parameters<typeof listRequests>[2]): string[] =>
    listRequests(store, ADMIN, { limit: 100, ...f }).rows.map((r) => r.id).sort();

  assert.deepEqual(ids({ userId: U1 }), ["req_a1", "req_a3"]);
  assert.deepEqual(ids({ userId: U2 }), ["req_a2"]);
  assert.deepEqual(ids({ servedModel: "claude-opus-4-5" }), ["req_a2"]);
  assert.deepEqual(ids({ credentialOrigin: "inbound_key" }), ["req_a2"]);
  assert.deepEqual(ids({ credentialOrigin: "fallback_server" }), [], "org B's origin must be empty");
  assert.deepEqual(ids({ errorsOnly: true }), ["req_a3"]);
  assert.deepEqual(ids({ sessionId: "sess_a1" }), ["req_a1"]);
  assert.deepEqual(ids({ sessionId: "sess_bbb" }), [], "org B's session must be empty");
  // Filters compose, and compose with tenancy.
  assert.deepEqual(ids({ userId: U1, errorsOnly: true }), ["req_a3"]);
  assert.deepEqual(ids({ userId: U2, errorsOnly: true }), []);
});

test("a SQL injection attempt in a filter value returns nothing, not everything", (t) => {
  const store = fresh(t);
  seedWorld(store);

  const attacks = [
    "x' OR 1=1 --",
    "' OR '1'='1",
    "claude-sonnet-4-5' --",
    "'; DROP TABLE requests; --",
  ];
  for (const attack of attacks) {
    assert.deepEqual(listRequests(store, ADMIN, { servedModel: attack }).rows, [], attack);
    assert.deepEqual(listRequests(store, ADMIN, { sessionId: attack }).rows, [], attack);
    assert.deepEqual(listRequests(store, ADMIN, { userId: attack }).rows, [], attack);
    assert.deepEqual(listRequests(store, ADMIN, { credentialOrigin: attack }).rows, [], attack);
    // The value must be a bound parameter, never spliced into the statement.
    const { sql, params } = feedSql(ADMIN, { servedModel: attack });
    assert.ok(!sql.includes(attack), "filter value was interpolated into the SQL");
    assert.ok(params.includes(attack), "filter value was not bound as a parameter");
  }
  // Nothing was dropped.
  assert.equal(usageTotals(store, ADMIN, SHORT).requests, 4);
});

// ── Source agreement ─────────────────────────────────────────────────────────

test("usageTotals agrees between the raw-rows path and the rollup path", (t) => {
  const store = fresh(t);
  seedWorld(store);

  assert.equal(chooseSource(SHORT), "requests");
  assert.equal(chooseSource(LONG), "usage_hourly");
  assert.equal(chooseSource({ fromMs: H, toMs: H + RAW_WINDOW_MS }), "requests");
  assert.equal(chooseSource({ fromMs: H, toMs: H + RAW_WINDOW_MS + 1 }), "usage_hourly");

  const raw = usageTotals(store, ADMIN, SHORT);
  const rollup = usageTotals(store, ADMIN, LONG);
  assert.deepEqual(rollup, raw, "the same traffic must total the same either way");

  // Per-dimension breakdowns agree too — which is what catches a cube read that
  // forgot to pin a dimension and so counted every request two to four times.
  const key = <T extends { readonly requests: number; readonly pricedCostUsd: number }>(
    rows: readonly T[],
    pick: (row: T) => string,
  ): unknown[] =>
    rows
      .map((r) => [pick(r), r.requests, r.pricedCostUsd])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  assert.deepEqual(
    key(usageByUser(store, ADMIN, LONG), (r) => r.userId),
    key(usageByUser(store, ADMIN, SHORT), (r) => r.userId),
  );
  assert.deepEqual(
    key(usageByModel(store, ADMIN, LONG), (r) => r.servedModel),
    key(usageByModel(store, ADMIN, SHORT), (r) => r.servedModel),
  );
  assert.deepEqual(
    key(usageByCredentialOrigin(store, ADMIN, LONG), (r) => r.credentialOrigin),
    key(usageByCredentialOrigin(store, ADMIN, SHORT), (r) => r.credentialOrigin),
  );
  assert.deepEqual(
    usageSeries(store, ADMIN, LONG).map((r) => [r.hourStart, r.requests]),
    usageSeries(store, ADMIN, SHORT).map((r) => [r.hourStart, r.requests]),
  );
  assert.deepEqual(
    usageByCredentialOrigin(store, ADMIN, LONG).map((r) => [r.credentialOrigin, r.distinctUsers]),
    usageByCredentialOrigin(store, ADMIN, SHORT).map((r) => [r.credentialOrigin, r.distinctUsers]),
  );
});

test("cacheHitRatio comes out of the shared pricing helper", (t) => {
  const store = fresh(t);
  seedOrg(store, ORG_A);
  seedRequest(store, ORG_A, { id: "h1", inputTokens: 100, cacheReadTokens: 300 });
  // 300 / (100 + 300)
  assert.equal(usageTotals(store, ADMIN, SHORT).cacheHitRatio, 0.75);
  assert.equal(usageTotals(store, ADMIN, LONG).cacheHitRatio, 0.75);

  const empty = fresh(t);
  seedOrg(empty, ORG_A);
  // No context at all is null, not 0: "unknown" and "nothing cached" differ.
  assert.equal(usageTotals(empty, ADMIN, SHORT).cacheHitRatio, null);
});

// ── Unattributed usage ───────────────────────────────────────────────────────

test("unattributed requests appear in usageByUser rather than vanishing", (t) => {
  const store = fresh(t);
  seedWorld(store);

  for (const range of [SHORT, LONG]) {
    const rows = usageByUser(store, ADMIN, range);
    const via = chooseSource(range);
    const unattributed = rows.find((r) => r.userId === "");
    assert.ok(unattributed, `${via}: the unattributed slice was hidden`);
    assert.equal(unattributed.email, null, via);
    assert.equal(unattributed.requests, 1, via);
    assert.equal(unattributed.usage.inputTokens, 7, via);

    // The breakdown must account for every request, or a dashboard silently
    // disagrees with its own headline number.
    const summed = rows.reduce((acc, r) => acc + r.requests, 0);
    assert.equal(summed, usageTotals(store, ADMIN, range).requests, via);

    // Emails are joined in for the users we do know.
    const one = rows.find((r) => r.userId === U1);
    assert.equal(one?.email, "one@aaa.test", via);
  }
});

test("usageByModel surfaces requests that never resolved a model", (t) => {
  const store = fresh(t);
  seedOrg(store, ORG_A);
  seedUser(store, ORG_A, U1, "one@aaa.test");
  seedRequest(store, ORG_A, { id: "m1", userId: U1, servedModel: "claude-sonnet-4-5" });
  seedRequest(store, ORG_A, {
    id: "m2",
    userId: U1,
    servedModel: null,
    status: "bad_request",
    httpStatus: 400,
  });

  for (const range of [SHORT, LONG]) {
    const rows = usageByModel(store, ADMIN, range);
    const via = chooseSource(range);
    assert.equal(rows.reduce((a, r) => a + r.requests, 0), 2, via);
    assert.equal(rows.find((r) => r.servedModel === "")?.requests, 1, via);
    assert.equal(rows.find((r) => r.servedModel === "claude-sonnet-4-5")?.requests, 1, via);
  }
});

// ── Errors ───────────────────────────────────────────────────────────────────

test("errorBreakdown groups non-ok requests, including ones with no error_type", (t) => {
  const store = fresh(t);
  seedOrg(store, ORG_A);
  seedUser(store, ORG_A, U1, "one@aaa.test");
  seedRequest(store, ORG_A, { id: "e1", userId: U1 });
  seedRequest(store, ORG_A, {
    id: "e2",
    userId: U1,
    status: "upstream_error",
    errorType: "overloaded_error",
    httpStatus: 529,
  });
  seedRequest(store, ORG_A, {
    id: "e3",
    userId: U1,
    status: "upstream_error",
    errorType: "overloaded_error",
    httpStatus: 529,
  });
  // An identity rejection: recorded on purpose, and it carries no error_type.
  seedRequest(store, ORG_A, { id: "e4", userId: null, status: "identity_denied", httpStatus: 401 });

  const rows = errorBreakdown(store, ADMIN, SHORT);
  assert.deepEqual(rows, [
    { errorType: "overloaded_error", httpStatus: 529, count: 2 },
    { errorType: null, httpStatus: 401, count: 1 },
  ]);
  // The error COUNT in totals must agree with the breakdown, on both sources.
  for (const range of [SHORT, LONG]) {
    assert.equal(usageTotals(store, ADMIN, range).errors, 3, chooseSource(range));
  }
});

// ── Latency ──────────────────────────────────────────────────────────────────

test("latency: exact percentiles from raw rows, interpolated from buckets", (t) => {
  const store = fresh(t);
  seedOrg(store, ORG_A);
  seedUser(store, ORG_A, U1, "one@aaa.test");
  // 8 fast, 1 mid, 1 slow → buckets [8, 1, 0, 1, 0, 0].
  const durations = [500, 500, 500, 500, 500, 500, 500, 500, 2000, 20_000];
  durations.forEach((d, i) => {
    seedRequest(store, ORG_A, { id: `l${i}`, userId: U1, durationMs: d, ttfbMs: 100 });
  });

  const raw = latencySummary(store, ADMIN, SHORT);
  assert.equal(raw.count, 10);
  assert.deepEqual(raw.buckets, [8, 1, 0, 1, 0, 0]);
  assert.equal(raw.maxDurationMs, 20_000);
  assert.equal(raw.avgTtfbMs, 100);
  // Exact, nearest-rank, from the rows themselves.
  assert.equal(raw.p50Ms, 500);
  assert.equal(raw.p95Ms, 20_000);

  const rollup = latencySummary(store, ADMIN, LONG);
  assert.deepEqual(rollup.buckets, raw.buckets, "bucket counts must add across rollup rows");
  assert.equal(rollup.count, raw.count);
  assert.equal(rollup.maxDurationMs, raw.maxDurationMs);
  assert.ok(Math.abs((rollup.avgDurationMs ?? 0) - (raw.avgDurationMs ?? 0)) < 1e-9);
  assert.equal(rollup.avgTtfbMs, 100);

  // Interpolated, so only the BUCKET is guaranteed — never assert equality with
  // the exact figure, because the interpolation is an estimate by construction.
  assert.ok(rollup.p50Ms !== null && rollup.p50Ms >= 0 && rollup.p50Ms < 1000, `${rollup.p50Ms}`);
  assert.ok(
    rollup.p95Ms !== null && rollup.p95Ms >= 10_000 && rollup.p95Ms <= 30_000,
    `${rollup.p95Ms}`,
  );
});

test("interpolatePercentile stays inside its bucket and floors the open-ended tail", () => {
  assert.equal(interpolatePercentile([0, 0, 0, 0, 0, 0], 0.5), null);
  // All in the first bucket: p50 is halfway across [0, 1000).
  assert.equal(interpolatePercentile([10, 0, 0, 0, 0, 0], 0.5), 500);
  // A percentile in the >=60s bucket has no upper edge to reach toward, so it
  // is reported as the 60s floor rather than an invented number.
  assert.equal(interpolatePercentile([0, 0, 0, 0, 0, 5], 0.95), 60_000);
  assert.equal(interpolatePercentile([99, 0, 0, 0, 0, 1], 0.999), 60_000);
  for (const p of [0.5, 0.9, 0.95, 0.99]) {
    const v = interpolatePercentile([1, 1, 1, 1, 1, 0], p);
    assert.ok(v !== null && v >= 0 && v <= 60_000, `p${p} = ${String(v)}`);
  }
});

// ── Quota ────────────────────────────────────────────────────────────────────

test("latestQuotaByUser takes the newest snapshot per user and skips headerless rows", (t) => {
  const store = fresh(t);
  seedOrg(store, ORG_A);
  seedUser(store, ORG_A, U1, "one@aaa.test");
  seedUser(store, ORG_A, U2, "two@aaa.test");

  seedRequest(store, ORG_A, { id: "q1", userId: U1, startedAt: H + 1000, rl5h: 0.2 });
  seedRequest(store, ORG_A, {
    id: "q2",
    userId: U1,
    startedAt: H + 5000,
    rl5h: 0.8,
    rlClaim: "five_hour",
  });
  // Newest row for U1, but it carried NO quota headers: it must not overwrite
  // the real snapshot with blanks.
  seedRequest(store, ORG_A, { id: "q3", userId: U1, startedAt: H + 9000, rl5h: null });
  seedRequest(store, ORG_A, { id: "q4", userId: U2, startedAt: H + 2000, rl5h: 0.5 });
  // An unattributed request with quota headers is still worth showing.
  seedRequest(store, ORG_A, { id: "q5", userId: null, startedAt: H + 3000, rl5h: 0.1 });

  const rows = latestQuotaByUser(store, ADMIN);
  assert.equal(rows.length, 3, "one snapshot per user, no duplicates");
  const u1 = rows.find((r) => r.userId === U1);
  assert.equal(u1?.fiveHourUtilization, 0.8);
  assert.equal(u1?.observedAt, H + 5000);
  assert.equal(u1?.claim, "five_hour");
  assert.equal(u1?.email, "one@aaa.test");
  assert.equal(u1?.fiveHourStatus, "allowed");
  assert.equal(rows.find((r) => r.userId === U2)?.fiveHourUtilization, 0.5);
  const unattributed = rows.find((r) => r.userId === null);
  assert.equal(unattributed?.fiveHourUtilization, 0.1);
  assert.equal(unattributed?.email, null);
  // Newest first.
  assert.deepEqual([...rows].sort((a, b) => b.observedAt - a.observedAt), rows);
});

// ── Query plans ──────────────────────────────────────────────────────────────

const USES_INDEX = /USING (COVERING )?INDEX|USING (INTEGER )?PRIMARY KEY/;

function plan(store: Store, sql: string, params: readonly (string | number | null)[]): string[] {
  const rows = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
    detail?: unknown;
  }>;
  return rows.map((r) => String(r.detail ?? ""));
}

test("the feed and the per-user rollup are index-driven, never table scans", (t) => {
  const store = fresh(t);
  seedWorld(store);
  // Enough rows that the planner has something to prefer, and stats to use.
  for (let i = 0; i < 2000; i += 1) {
    seedRequest(store, ORG_A, { id: `bulk${i}`, userId: U1, startedAt: H + 10_000 + i });
  }
  store.db.exec("ANALYZE");

  const cases: Array<[string, { sql: string; params: (string | number | null)[] }]> = [
    ["feed", feedSql(ADMIN, { limit: 50 })],
    ["feed+cursor", feedSql(ADMIN, { limit: 50, beforeSeq: 900 })],
    ["feed+user", feedSql(ADMIN, { limit: 50, userId: U1 })],
    ["feed as member", feedSql(MEMBER, { limit: 50 })],
    ["usageByUser rollup", usageByUserSql(ADMIN, LONG)],
    ["usageByUser raw", usageByUserSql(ADMIN, SHORT)],
  ];

  for (const [name, q] of cases) {
    const details = plan(store, q.sql, q.params);
    const joined = details.join(" | ");
    assert.ok(
      !/\bSCAN requests\b/.test(joined),
      `${name} full-scans requests: ${joined}`,
    );
    assert.ok(
      !/\bSCAN usage_hourly\b/.test(joined),
      `${name} full-scans usage_hourly: ${joined}`,
    );
    assert.ok(USES_INDEX.test(joined), `${name} used no index: ${joined}`);
  }
});

/**
 * Feed columns must cover every field `RequestRow` claims to have.
 *
 * Written after a real one: `pipeline`, `route_id` and
 * `credentials_considered` were written correctly by the writer and read
 * correctly by the mapper, but `FEED_COLUMNS` never selected them — so the API
 * silently returned the SCHEMA DEFAULTS. Every substituted request reported
 * `pipeline: "passthrough"`, `routeId: null` and an empty credential trail:
 * plausible values, uniformly wrong, and invisible to any test that did not
 * compare the projection against the type.
 *
 * Asserting the SELECT list against the mapper's output is what makes the next
 * added field fail loudly instead of defaulting quietly.
 */
test("the feed SELECT covers every column the row mapper reads", () => {
  const { sql } = feedSql({ orgId: "org", role: "admin" }, {});
  const selected = sql.slice(0, sql.indexOf("FROM"));

  for (const column of [
    "pipeline",
    "route_id",
    "credentials_considered",
    "cost_usd",
    "cost_basis",
    "rl_claim",
    "client_version",
    "service_tier",
  ]) {
    assert.ok(
      selected.includes(`r.${column}`),
      `${column} is read by toRequestRow but not selected — it will silently return the column default`,
    );
  }
});
