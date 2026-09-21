#!/usr/bin/env node
/**
 * Fest CLI.
 *
 *   fest serve                        run the gateway
 *   fest migrate                      apply schema migrations
 *   fest token create <email> [name]  mint an identity token (shown once)
 *   fest token list
 *   fest token revoke <token-id>
 *   fest seed [--requests N] [--hours N] [--force]
 *                                     synthetic traffic, for looking at the
 *                                     dashboard without a live session
 *   fest seed --reset                 discard the database, then seed it fresh
 *   fest seed --clear                 discard the database and stop
 */

import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig, describeConfig } from "../config.ts";
import type { FestConfig } from "../config.ts";
import { createUsageSink } from "../ingest/sink.ts";
import { createLiveBus } from "../ingest/live-bus.ts";
import { createServer } from "../http/server.ts";
import { log, setLogLevel } from "../log.ts";
import { openStore, migrate } from "../store/db.ts";
import type { Store } from "../store/db.ts";
import { ensureOrg, ensureUser, findUserByEmail } from "../store/bootstrap.ts";
import { createToken, listTokens, revokeToken, resolveToken, createLastUsedTracker } from "../store/tokens.ts";
import { createRequestWriter } from "../store/write.ts";
import { startRetention, DEFAULT_RETENTION } from "../store/retention.ts";
import { seed, existingRequestCount, isDefaultDatabase } from "../store/seed.ts";
import { parseRouteTable, EMPTY_ROUTE_TABLE } from "../routes/table.ts";
import type { RouteTable } from "../routes/table.ts";
import { readFile } from "node:fs/promises";

const out = (s: string): void => void process.stdout.write(s + "\n");

async function withStore(cfg: FestConfig): Promise<Store> {
  await mkdir(dirname(cfg.dbPath), { recursive: true });
  const store = openStore(cfg.dbPath);
  // Migrations run before anything else touches the schema, so a fresh volume
  // and an upgraded one behave identically.
  const { applied, version } = migrate(store);
  if (applied > 0) log.info("migrations applied", { applied, version });
  return store;
}

/**
 * Load and validate the routing table at BOOT, not on first use.
 *
 * A config error must stop the process here, where an operator is watching,
 * rather than surfacing as a failed request to a developer hours later. And a
 * table that fails to parse must never degrade to "no routing": that would
 * silently send substituted traffic back onto developers' subscriptions, which
 * is the exact silent-billing-substitution failure this phase is designed
 * against.
 */
async function loadRoutes(cfg: FestConfig): Promise<RouteTable> {
  if (cfg.routesPath === null) return EMPTY_ROUTE_TABLE;
  const text = await readFile(cfg.routesPath, "utf8");
  const table = parseRouteTable(text);
  log.info("routing table loaded", {
    path: cfg.routesPath,
    version: table.version,
    routes: table.routes.length,
    upstreams: [...table.upstreams.keys()],
  });
  return table;
}

async function cmdServe(cfg: FestConfig): Promise<void> {
  const routes = await loadRoutes(cfg);
  const store = await withStore(cfg);
  const org = ensureOrg(store);
  const writer = createRequestWriter(store);
  const lastUsed = createLastUsedTracker(store);
  // Hourly sweep, on a timer rather than at boot: a restart loop must not turn
  // into a delete loop.
  const retention = startRetention(store, DEFAULT_RETENTION);

  await mkdir(dirname(cfg.usageLogPath), { recursive: true });
  const bus = createLiveBus();
  const sink = createUsageSink({
    path: cfg.usageLogPath,
    // The store is the system of record; JSONL stays as a cheap, greppable
    // trail. Pricing and persistence both happen here in the flush, never on
    // the request path.
    //
    // The live feed is published AFTER the write, so a dashboard never shows a
    // row that then fails to persist. A throwing write requeues the batch and
    // publishes on the retry instead, which is the right way round: the feed
    // may lag the truth, but it must not contradict it.
    onBatch: (records) => {
      writer.writeBatch(org.id, records);
      bus.publish(records);
    },
  });

  const server = createServer({
    config: cfg,
    sink,
    bus,
    routes,
    orgId: org.id,
    store,
    resolveIdentity: (raw) => resolveToken(store, raw),
    touchToken: (id) => lastUsed.touch(id),
  });

  /**
   * How long an in-flight request may keep the process alive on shutdown.
   *
   * Long enough not to guillotine a developer mid-turn; short enough that
   * `node --watch` feels like a restart rather than a hang.
   */
  const DRAIN_GRACE_MS = 5_000;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });

    const finish = (): void => {
      void sink.close().then(() => {
        retention.stop();
        lastUsed.stop();
        store.close();
        log.info("drained", { sink: sink.stats() });
        process.exit(0);
      });
    };

    server.close(finish);

    // `server.close()` stops accepting but WAITS for every open connection.
    // An SSE stream never ends by itself, so a single open dashboard would
    // block shutdown indefinitely — which under `node --watch` looks like a
    // restart stuck on "Waiting for graceful termination". Hang up on the
    // dashboards explicitly; they reconnect on their own.
    bus.closeAll();
    server.closeIdleConnections();

    // Whatever is left is a request genuinely in flight. Give it a bounded
    // grace period, then stop waiting: a developer's next keystroke restarting
    // the server matters more than the tail of one turn, and the sink has
    // already been told to drain.
    const forced = setTimeout(() => {
      log.warn("shutdown grace expired; closing remaining connections", {
        afterMs: DRAIN_GRACE_MS,
      });
      server.closeAllConnections();
      finish();
    }, DRAIN_GRACE_MS);
    forced.unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.listen(cfg.port, cfg.host, () => {
    log.info("fest listening", describeConfig(cfg));
    out(
      `fest: http://${cfg.host}:${cfg.port}  ->  ${cfg.upstreamBaseUrl}\n` +
        `  db: ${cfg.dbPath}   identity required: ${cfg.requireIdentity}\n` +
        `  retention: requests ${DEFAULT_RETENTION.requestDays}d, rollups ${DEFAULT_RETENTION.rollupDays}d\n` +
        `  routing: ${
          routes.routes.length === 0
            ? "none — every request passes through on the caller's own credential"
            : `${routes.routes.length} route(s) via ${cfg.routesPath} (v${routes.version})`
        }\n` +
        `point Claude Code at it with:\n` +
        `  ANTHROPIC_BASE_URL=http://${cfg.host}:${cfg.port}/t/<your-token>\n` +
        `and do NOT set ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (either disables your subscription)`,
    );
  });
}

async function cmdToken(cfg: FestConfig, argv: readonly string[]): Promise<void> {
  const store = await withStore(cfg);
  const org = ensureOrg(store);
  const sub = argv[0] ?? "list";

  if (sub === "create") {
    const email = argv[1];
    if (email === undefined) throw new Error("usage: fest token create <email> [name]");
    const user = ensureUser(store, { orgId: org.id, email, role: "member" });
    const created = createToken(store, { orgId: org.id, userId: user.id, name: argv[2] ?? "" });
    out(`token id : ${created.id}`);
    out(`user     : ${user.email}`);
    out("");
    // Shown exactly once: only the hash is stored.
    out(`  ${created.raw}`);
    out("");
    out("This is the only time the token is shown. Use it as:");
    out(`  ANTHROPIC_BASE_URL=http://${cfg.host}:${cfg.port}/t/${created.raw}`);
  } else if (sub === "list") {
    const rows = listTokens(store, org.id);
    if (rows.length === 0) out("(no tokens)");
    for (const r of rows) {
      const state = r.revokedAt !== null ? "revoked" : "active";
      out(
        `${r.id}  ${r.displayPrefix}…  ${state.padEnd(7)}  user=${r.userId}  ` +
          `last-used=${r.lastUsedAt === null ? "never" : new Date(r.lastUsedAt).toISOString()}  ${r.name}`,
      );
    }
  } else if (sub === "revoke") {
    const id = argv[1];
    if (id === undefined) throw new Error("usage: fest token revoke <token-id>");
    out(revokeToken(store, org.id, id) ? `revoked ${id}` : `not found or already revoked: ${id}`);
  } else {
    throw new Error(`unknown token subcommand: ${sub}`);
  }
  store.close();
}

function intFlag(argv: readonly string[], name: string): number | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} needs a positive integer`);
  return n;
}

/**
 * Discard a database entirely, rather than deleting rows from it.
 *
 * Unlink and not `DELETE FROM`: once synthetic and observed rows share a table
 * there is no honest predicate that separates them, so a partial wipe would
 * have to guess. Removing the file is total and unambiguous — you know exactly
 * what you have afterwards, which is nothing.
 *
 * Refuses the default database without `--force`, because the one thing this
 * command must never do is silently destroy a real record of a team's usage on
 * the way to showing someone a demo.
 */
async function discardDatabase(cfg: FestConfig, force: boolean): Promise<void> {
  if (isDefaultDatabase(cfg.dbPath) && !force) {
    throw new Error(
      `refusing to delete the default database (${cfg.dbPath}).\n` +
        "That is where real traffic is recorded. Point at a scratch database:\n" +
        "  npm run demo:clean          (uses ./data/demo.db)\n" +
        "  FEST_DB=./data/scratch.db node server/bin/fest.ts seed --clear\n" +
        "or pass --force if you genuinely mean this one.",
    );
  }

  // The -wal and -shm siblings hold committed pages. Leaving them behind next
  // to a deleted main file is how a "cleared" database comes back populated.
  await Promise.all(
    [cfg.dbPath, `${cfg.dbPath}-wal`, `${cfg.dbPath}-shm`].map((f) =>
      rm(f, { force: true }),
    ),
  );
}

async function cmdSeed(cfg: FestConfig, argv: readonly string[]): Promise<void> {
  const force = argv.includes("--force");
  const clear = argv.includes("--clear");
  const reset = argv.includes("--reset");

  if (clear || reset) {
    await discardDatabase(cfg, force);
    out(`discarded ${cfg.dbPath}`);
    if (clear) return;
  }

  const store = await withStore(cfg);
  const existing = existingRequestCount(store);

  // Invented numbers must never be blended into observed ones. A dashboard is
  // only worth anything if you can trust that what it shows was measured.
  if (existing > 0 && !force) {
    store.close();
    throw new Error(
      `${cfg.dbPath} already holds ${existing} request(s).\n` +
        "Seeding would mix synthetic rows into real traffic. Either start clean:\n" +
        "  npm run demo                (scratch database, reset each time)\n" +
        "  node server/bin/fest.ts seed --reset\n" +
        "or pass --force if you are certain this database is disposable.",
    );
  }

  const requests = intFlag(argv, "requests");
  const hours = intFlag(argv, "hours");
  const result = seed(store, {
    ...(requests === undefined ? {} : { requests }),
    ...(hours === undefined ? {} : { hours }),
  });
  store.close();

  out(`seeded ${result.written} synthetic requests into ${cfg.dbPath}`);
  out(`developers: ${result.users.join(", ")}`);
  out("");
  out("These rows are INVENTED. Discard them with --clear before trusting any");
  out("number in this database.");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "serve";
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  switch (cmd) {
    case "serve":
      await cmdServe(cfg);
      return;
    case "migrate": {
      const store = await withStore(cfg);
      ensureOrg(store);
      const version = store.db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
      out(`migrated: ${cfg.dbPath} (user_version=${Object.values(version)[0]})`);
      store.close();
      return;
    }
    case "token":
      await cmdToken(cfg, argv.slice(1));
      return;
    case "seed":
      await cmdSeed(cfg, argv.slice(1));
      return;
    case "help":
    case "--help":
    case "-h":
      out(
        "fest serve | migrate |\n" +
          "     seed [--requests N] [--hours N] [--reset | --clear] [--force] |\n" +
          "     token create <email> [name] | token list | token revoke <id>",
      );
      return;
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

main().catch((err) => {
  process.stderr.write(`fest: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
