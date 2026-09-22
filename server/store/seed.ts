/**
 * Synthetic traffic, for looking at the dashboard without a live Max session.
 *
 * Development-only, and honest about it: every generated row is real in shape
 * but invented in content, so it must never be mixed into a database that also
 * holds observed traffic. `fest seed` therefore refuses to run against a
 * non-empty `requests` table unless told to, rather than quietly contaminating
 * a real record with numbers nobody measured.
 *
 * The generator is deterministic (a fixed-seed PRNG, not `Math.random`) so two
 * people looking at "the dashboard with seed data" are looking at the same
 * dashboard, and a screenshot in a bug report means something.
 *
 * What it deliberately reproduces, because these are the cases the UI must get
 * right and a happy-path generator would never produce:
 *
 *  - subscription rows with `costUsd: null` and a populated `notionalCostUsd` —
 *    no org spend, but real value; the first must never render as `$0.00` or be
 *    summed into org spend, and the second must never be summed into it either;
 *  - rows with no resolved model, which are unpriced on BOTH figures;
 *  - a few `fallback_server` rows — real org spend, which the posture screen is
 *    supposed to shout about;
 *  - unattributed rows with no `userId` — somebody running without a token;
 *  - errors, aborts and a 401, which is expected traffic rather than a fault;
 *  - large 1-hour cache writes, because that is what Claude Code actually does.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { UsageRecord } from "../../shared/types.ts";
import { priceUsage } from "../usage/pricing.ts";
import type { Store } from "./db.ts";
import { createRequestWriter } from "./write.ts";
import { ensureOrg, ensureUser } from "./bootstrap.ts";

/** Mulberry32 — tiny, and the same sequence on every machine. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODELS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
] as const;

const SEED_USERS = ["ada@corp.test", "grace@corp.test", "alan@corp.test"] as const;

export interface SeedOptions {
  readonly orgId: string;
  /** User ids to attribute traffic to, in order of decreasing volume. */
  readonly userIds: readonly string[];
  readonly requests?: number;
  readonly hours?: number;
  readonly seed?: number;
  readonly now?: number;
}

export function generateRecords(opts: SeedOptions): UsageRecord[] {
  const count = opts.requests ?? 400;
  const hours = opts.hours ?? 48;
  const now = opts.now ?? Date.now();
  const rand = prng(opts.seed ?? 1337);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

  const records: UsageRecord[] = [];

  for (let i = 0; i < count; i += 1) {
    // Bias toward recent hours: a real team's traffic is not uniform, and a
    // flat histogram would hide whether the chart's time axis works at all.
    const ageHours = Math.floor(hours * rand() * rand());
    const startedAt = now - ageHours * 3_600_000 - Math.floor(rand() * 3_600_000);

    // Weighted so the first-listed developer dominates, with a tail of
    // unattributed traffic — the case the Users screen exists to surface.
    const roll = rand();
    const userId =
      roll < 0.08 ? null : (opts.userIds[Math.floor(rand() * rand() * opts.userIds.length)] ?? null);

    const originRoll = rand();
    const credentialOrigin =
      originRoll < 0.9 ? "inbound_subscription" : originRoll < 0.97 ? "fallback_server" : "inbound_key";
    const subscription = credentialOrigin === "inbound_subscription";

    const statusRoll = rand();
    const status =
      statusRoll < 0.93
        ? "ok"
        : statusRoll < 0.96
          ? "client_abort"
          : statusRoll < 0.98
            ? "upstream_error"
            : statusRoll < 0.99
              ? "identity_denied"
              : "stream_error";

    const httpStatus =
      status === "ok" || status === "client_abort"
        ? 200
        : status === "identity_denied"
          ? 401
          : rand() < 0.5
            ? 429
            : 500;

    // Claude Code caches aggressively with a 1-hour TTL, so most of the context
    // is a cache read and cache writes are large and occasional.
    const cached = rand() < 0.75;
    const cacheRead = cached ? 8_000 + Math.floor(rand() * 40_000) : 0;
    const cacheWrite1h = cached && rand() < 0.3 ? 5_000 + Math.floor(rand() * 30_000) : 0;
    const cacheWrite5m = !cached && rand() < 0.2 ? 500 + Math.floor(rand() * 4_000) : 0;
    const inputTokens = 2 + Math.floor(rand() * 400);
    const outputTokens = status === "ok" ? 20 + Math.floor(rand() * 1_500) : Math.floor(rand() * 60);

    const ttfbMs = 400 + Math.floor(rand() * 2_200);
    const durationMs = ttfbMs + Math.floor(rand() * rand() * 70_000);

    // 2% of rows never resolved a model, which is what an unpriceable row looks
    // like in production — the dashboard must show those as "n/a", not "$0".
    const servedModel = rand() < 0.02 ? null : pick(MODELS);
    const usage = {
      inputTokens,
      cacheReadTokens: cacheRead,
      cacheWrite5mTokens: cacheWrite5m,
      cacheWrite1hTokens: cacheWrite1h,
      outputTokens,
      webSearches: 0,
    };
    const priced = priceUsage(servedModel, usage, subscription);

    // Utilisation climbs through the window, so the quota panel has both a
    // comfortable developer and one close to the wall.
    const util = Math.min(0.99, 0.15 + (1 - ageHours / hours) * rand() * 1.1);

    records.push({
      id: randomUUID(),
      startedAt,
      endedAt: startedAt + durationMs,
      posture: credentialOrigin === "inbound_key" ? "key" : "subscription",
      identityCarrier: userId === null ? "none" : "path",
      callerFingerprint: userId === null ? null : `fp${(i % 7) + 1}`.padEnd(12, "0"),
      userId,
      tokenId: userId === null ? null : `tok-${userId}`,
      credentialFingerprint: `cred${(i % 5) + 1}`.padEnd(12, "0"),
      credentialOrigin,
      sessionId: `sess-${Math.floor(i / 12)}`,
      requestedModel: pick(MODELS),
      servedModel,
      upstream: "https://api.anthropic.com",
      stream: true,
      status,
      httpStatus,
      ...(status === "ok" || status === "client_abort" ? {} : { errorType: status }),
      partial: status === "client_abort" || status === "stream_error",
      usage,
      // Priced through the REAL engine rather than with invented numbers, so
      // the demo exercises the same null-vs-value behaviour production does: a
      // subscription row gets `costUsd: null` with a populated notional figure,
      // and the 2% of rows with no resolved model come out unpriced on both.
      costUsd: priced.cost,
      costBasis: priced.basis,
      notionalCostUsd: priced.notionalCost,
      ttfbMs: status === "identity_denied" ? null : ttfbMs,
      durationMs,
      bytesIn: 1_000 + Math.floor(rand() * 50_000),
      bytesOut: 500 + Math.floor(rand() * 90_000),
      upstreamRequestId: `req_seed_${i}`,
      rateLimit: subscription
        ? {
            status: "allowed",
            fiveHourUtilization: Number(util.toFixed(3)),
            fiveHourStatus: util > 0.95 ? "rejected" : "allowed",
            fiveHourResetAt: startedAt + 3_600_000,
            sevenDayUtilization: Number((util * 0.3).toFixed(3)),
            sevenDayStatus: "allowed",
            sevenDayResetAt: startedAt + 5 * 86_400_000,
            representativeClaim: "five_hour",
            overageStatus: util > 0.95 ? "rejected" : "allowed",
            ...(util > 0.95 ? { overageDisabledReason: "not_enabled_for_org" } : {}),
          }
        : null,
      clientVersion: "2.1.278",
      pipeline: credentialOrigin === "fallback_server" ? "substitute" : "passthrough",
      routeId: credentialOrigin === "fallback_server" ? "demo-substitute" : null,
      credentialsConsidered:
        credentialOrigin === "fallback_server"
          ? [
              {
                source: "inbound_subscription",
                result: "skipped",
                reason: "a Claude subscription credential is only valid at Anthropic",
              },
              { source: "env:DEMO_PROVIDER_KEY", result: "used" },
            ]
          : [{ source: `inbound_${subscription ? "subscription" : "key"}`, result: "used" }],
    });
  }

  // Oldest first, so rowids run in the same direction as time and the keyset
  // feed reads the way it will in production.
  return records.sort((a, b) => a.startedAt - b.startedAt);
}

export interface SeedResult {
  readonly written: number;
  readonly users: readonly string[];
}

export function seed(store: Store, opts: { requests?: number; hours?: number } = {}): SeedResult {
  const org = ensureOrg(store);
  const userIds = SEED_USERS.map(
    (email) => ensureUser(store, { orgId: org.id, email, role: "member" }).id,
  );
  const records = generateRecords({
    orgId: org.id,
    userIds,
    ...(opts.requests === undefined ? {} : { requests: opts.requests }),
    ...(opts.hours === undefined ? {} : { hours: opts.hours }),
  });
  const written = createRequestWriter(store).writeBatch(org.id, records);
  return { written, users: SEED_USERS };
}

/** The database `serve` uses by default. Never wiped without an explicit say-so. */
export const DEFAULT_DB_PATH = "./data/fest.db";

/**
 * Is this the database that records real traffic?
 *
 * Path-resolved rather than string-compared, so `data/fest.db`,
 * `./data/fest.db` and an absolute path all answer the same. A guard that can
 * be stepped around by spelling the path differently is not a guard.
 */
export function isDefaultDatabase(dbPath: string): boolean {
  return resolve(dbPath) === resolve(DEFAULT_DB_PATH);
}

export function existingRequestCount(store: Store): number {
  const row = store.db.prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number };
  return row.n;
}
