/**
 * The bench's database: a real Fest store, built through the real store
 * modules, sized like a real deployment.
 *
 * An empty database flatters every dashboard query, and a dashboard query is
 * the most likely thing to stall a worker's streams — so the fixture carries
 * weeks of synthetic history (`generateRecords`, the same generator `fest seed`
 * uses) across every simulated developer, plus an owner with a live session for
 * the dashboard pollers and one identity token per developer.
 *
 * Built once per bench invocation and copied for each run, so every worker
 * count starts from byte-identical data.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, migrate } from "../../server/store/db.ts";
import { ensureOrg, ensureUser } from "../../server/store/bootstrap.ts";
import { createToken } from "../../server/store/tokens.ts";
import { createSession, cookieName } from "../../server/auth/session.ts";
import { createRequestWriter } from "../../server/store/write.ts";
import { generateRecords } from "../../server/store/seed.ts";

export interface FixtureOptions {
  readonly developers: number;
  readonly historyRows: number;
  readonly historyDays: number;
}

export interface Fixture {
  readonly dbPath: string;
  readonly tokens: readonly string[];
  /** `name=value`, ready for a Cookie header. */
  readonly cookie: string;
  readonly historyRows: number;
}

const BATCH = 10_000;

export function buildFixture(dir: string, opts: FixtureOptions): Fixture {
  const dbPath = join(dir, "template.db");
  const store = openStore(dbPath);
  try {
    migrate(store);
    const org = ensureOrg(store);
    const owner = ensureUser(store, { orgId: org.id, email: "bench-owner@bench.test", role: "owner" });
    const session = createSession(store, { orgId: org.id, userId: owner.id, userAgent: "fest-bench" });

    const userIds: string[] = [];
    const tokens: string[] = [];
    store.transaction(() => {
      for (let i = 0; i < opts.developers; i += 1) {
        const user = ensureUser(store, { orgId: org.id, email: `dev${i}@bench.test`, role: "member" });
        userIds.push(user.id);
        tokens.push(createToken(store, { orgId: org.id, userId: user.id, name: "bench" }).raw);
      }
    });

    const records = generateRecords({
      orgId: org.id,
      userIds,
      requests: opts.historyRows,
      hours: opts.historyDays * 24,
      seed: 7,
    });
    const writer = createRequestWriter(store);
    for (let i = 0; i < records.length; i += BATCH) writer.writeBatch(org.id, records.slice(i, i + BATCH));
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    return { dbPath, tokens, cookie: `${cookieName(false)}=${session.raw}`, historyRows: records.length };
  } finally {
    store.close();
  }
}

/** A routing table that sends `bench-oss-*` to the fake upstream on a server key. */
export function writeRoutes(dir: string, upstreamUrl: string): string {
  const path = join(dir, "routes.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        upstreams: {
          bench: { adapter: "fireworks", baseUrl: `${upstreamUrl}/inference`, credential: "{env:BENCH_ROUTE_KEY}" },
        },
        routes: [{ id: "bench-oss", match: "bench-oss-*", upstream: "bench", model: "accounts/fireworks/models/bench" }],
      },
      null,
      2,
    ),
  );
  return path;
}
