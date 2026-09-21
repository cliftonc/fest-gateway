#!/usr/bin/env node
/**
 * Fest CLI.
 *
 *   fest serve                        run the gateway
 *   fest migrate                      apply schema migrations
 *   fest token create <email> [name]  mint an identity token (shown once)
 *   fest token list
 *   fest token revoke <token-id>
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig, describeConfig } from "../config.ts";
import type { FestConfig } from "../config.ts";
import { createUsageSink } from "../ingest/sink.ts";
import { createServer } from "../http/server.ts";
import { log, setLogLevel } from "../log.ts";
import { openStore, migrate } from "../store/db.ts";
import type { Store } from "../store/db.ts";
import { ensureOrg, ensureUser, findUserByEmail } from "../store/bootstrap.ts";
import { createToken, listTokens, revokeToken, resolveToken, createLastUsedTracker } from "../store/tokens.ts";
import { createRequestWriter } from "../store/write.ts";

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

async function cmdServe(cfg: FestConfig): Promise<void> {
  const store = await withStore(cfg);
  const org = ensureOrg(store);
  const writer = createRequestWriter(store);
  const lastUsed = createLastUsedTracker(store);

  await mkdir(dirname(cfg.usageLogPath), { recursive: true });
  const sink = createUsageSink({
    path: cfg.usageLogPath,
    // The store is the system of record; JSONL stays as a cheap, greppable
    // trail. Pricing and persistence both happen here in the flush, never on
    // the request path.
    onBatch: (records) => writer.writeBatch(org.id, records),
  });

  const server = createServer({
    config: cfg,
    sink,
    orgId: org.id,
    resolveIdentity: (raw) => resolveToken(store, raw),
    touchToken: (id) => lastUsed.touch(id),
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    server.close(() => {
      void sink.close().then(() => {
        lastUsed.stop();
        store.close();
        log.info("drained", { sink: sink.stats() });
        process.exit(0);
      });
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.listen(cfg.port, cfg.host, () => {
    log.info("fest listening", describeConfig(cfg));
    out(
      `fest: http://${cfg.host}:${cfg.port}  ->  ${cfg.upstreamBaseUrl}\n` +
        `  db: ${cfg.dbPath}   identity required: ${cfg.requireIdentity}\n` +
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
    case "help":
    case "--help":
    case "-h":
      out("fest serve | migrate | token create <email> [name] | token list | token revoke <id>");
      return;
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

main().catch((err) => {
  process.stderr.write(`fest: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
