#!/usr/bin/env node
/**
 * Fest CLI.
 *
 * Server operator commands (need FEST_* server env, run on the host):
 *   fest serve                        run the gateway
 *   fest migrate                      apply schema migrations
 *   fest token create <email> [name]  mint an identity token (shown once)
 *   fest token list
 *   fest token revoke <token-id>
 *   fest admin create <email> [--role owner|admin|member] [--password-stdin]
 *                                     grant dashboard sign-in (password shown once)
 *   fest admin list
 *   fest admin passwd <email> [--password-stdin]
 *   fest admin disable <email> | fest admin enable <email>
 *   fest seed [--requests N] [--hours N] [--force]
 *                                     synthetic traffic, for looking at the
 *                                     dashboard without a live session
 *   fest seed --reset                 discard the database, then seed it fresh
 *   fest seed --clear                 discard the database and stop
 *
 * Developer commands (run on your own machine, no server env needed):
 *   fest login [--provider google|github] [--server <url>]
 *                                     sign in via OAuth, store a token in ~/.fest
 *   fest whoami                       show the locally stored login
 *   fest claude [gw] [-- claude args...]
 *                                     run `claude` pointed at your Fest gateway.
 *                                     Posture is auto-detected: your own Anthropic
 *                                     login pays if you have one, org credentials
 *                                     if you do not. `gw` forces org credentials
 *                                     and the gateway model menu.
 *   fest logout                       forget the local login
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
import { grantDashboardAccess, hasAnyOwner, normaliseEmail } from "../auth/accounts.ts";
import { revokeUserSessions } from "../auth/session.ts";
import { isLoopbackHost } from "../auth/guard.ts";
import { generatePassword } from "../auth/password.ts";
import { recordAudit } from "../store/audit.ts";
import { createRequestWriter } from "../store/write.ts";
import { startRetention, DEFAULT_RETENTION } from "../store/retention.ts";
import { loadPrices, startPriceRefresh, pricingOptionsFromEnv } from "../usage/prices/refresh.ts";
import { seed, existingRequestCount, isDefaultDatabase } from "../store/seed.ts";
import { parseRouteTable, EMPTY_ROUTE_TABLE } from "../routes/table.ts";
import { watchRoutes } from "../routes/watch.ts";
import type { RouteTable } from "../routes/table.ts";
import { readFile } from "node:fs/promises";
import { runLogin } from "../../cli/login.ts";
import { runWhoami } from "../../cli/whoami.ts";
import { runClaude } from "../../cli/claude.ts";
import { runLogout } from "../../cli/logout.ts";
import { readCliConfig } from "../../cli/config.ts";

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
  // Edits to routes.json take effect without a restart. `node --watch` only
  // tracks imported .ts files, so without this an edit appeared to do nothing —
  // which reads as "my config is wrong" rather than "it has not been loaded".
  const routeWatcher =
    cfg.routesPath === null ? null : watchRoutes(cfg.routesPath, routes);
  const store = await withStore(cfg);
  const org = ensureOrg(store);

  /**
   * Refuse to serve an unauthenticated dashboard off loopback.
   *
   * The API exposes every developer's usage. On 127.0.0.1 that is a
   * single-developer trial and asking for a password first would be friction
   * for no one's benefit; on any other interface it is a data leak waiting for
   * someone to find the port. Failing at boot — where an operator is watching —
   * beats failing as a quiet exposure nobody notices.
   */
  if (!isLoopbackHost(cfg.host) && !hasAnyOwner(store, org.id)) {
    store.close();
    throw new Error(
      `refusing to listen on ${cfg.host} with no owner account.\n` +
        "The dashboard would serve every developer's usage to anyone who finds the port.\n" +
        "Create one first:\n" +
        "  node server/bin/fest.ts admin create you@corp.test\n" +
        "  (in Docker: docker compose run --rm fest admin create you@corp.test)\n" +
        "or bind to loopback (FEST_HOST=127.0.0.1) for a single-developer trial.",
    );
  }

  // Prices load synchronously from the vendored snapshot before the first
  // request can arrive, so a call is never metered against an empty table. The
  // refresh that follows is best-effort and off the hot path — see
  // usage/prices/refresh.ts for why boot must never wait on it.
  const pricing = pricingOptionsFromEnv(cfg.dbPath);
  loadPrices(pricing);
  const priceRefresh = startPriceRefresh(pricing);

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
    routes: routeWatcher === null ? routes : () => routeWatcher.current(),
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
        priceRefresh.stop();
        routeWatcher?.stop();
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
    recordAudit(store, {
      orgId: org.id,
      actorLabel: "cli",
      action: "token.create",
      target: created.id,
      outcome: "ok",
      detail: { user: user.email, name: argv[2] ?? "" },
    });
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
    const revoked = revokeToken(store, org.id, id);
    recordAudit(store, {
      orgId: org.id,
      actorLabel: "cli",
      action: "token.revoke",
      target: id,
      outcome: revoked ? "ok" : "denied",
    });
    out(revoked ? `revoked ${id}` : `not found or already revoked: ${id}`);
  } else {
    throw new Error(`unknown token subcommand: ${sub}`);
  }
  store.close();
}

/**
 * Read a password from stdin when asked to, otherwise generate one.
 *
 * Never from a command-line argument: `fest admin create x --password hunter2`
 * puts the password in the shell history, in `ps` output for every user on the
 * box, and often in a CI log. `--password-stdin` is the automation path; the
 * default is a generated password shown once, which is the one most operators
 * should take.
 */
async function readPassword(argv: readonly string[]): Promise<{ password: string; generated: boolean }> {
  if (!argv.includes("--password-stdin")) return { password: generatePassword(), generated: true };
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (password === "") throw new Error("--password-stdin was given but stdin was empty");
  return { password, generated: false };
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * Did this user already have console access — a password of their own —
 * before this call? `ensureUser` also runs for metering-only rows (an
 * identity token, or an OAuth self-service login that never went through
 * `admin create`), so "a row exists" is not the same question.
 */
function hadConsoleAccess(store: Store, userId: string): boolean {
  const row = store.db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(userId) as
    | { password_hash: string | null }
    | undefined;
  return row !== undefined && row.password_hash !== null;
}

async function cmdAdmin(cfg: FestConfig, argv: readonly string[]): Promise<void> {
  const store = await withStore(cfg);
  const org = ensureOrg(store);
  const sub = argv[0] ?? "list";

  try {
    if (sub === "create" || sub === "passwd") {
      const email = argv[1];
      if (email === undefined) throw new Error(`usage: fest admin ${sub} <email> [--role R] [--password-stdin]`);

      const roleFlag = flagValue(argv, "role");
      if (roleFlag !== undefined && !["owner", "admin", "member"].includes(roleFlag)) {
        throw new Error("--role must be owner, admin or member");
      }

      /**
       * An existing user keeps their role unless `--role` says otherwise.
       *
       * Found by running it: `admin passwd` on the only owner silently demoted
       * them to `admin`, which left the deployment with no owner — and an
       * ownerless deployment on loopback serves the API unauthenticated. A
       * routine password rotation therefore turned the dashboard's auth off.
       * Changing a password must change exactly the password.
       *
       * Only when the user is new to the CONSOLE does the default apply, and
       * then the FIRST such account is the owner whatever it asked for: a
       * deployment with only an `admin` has nobody able to grant the owner
       * role afterwards. A metering-only row (minted by `fest token create`,
       * or by an OAuth `fest login` that never touched the console) does not
       * count as "existing" for this purpose — granting it console access for
       * the first time is exactly the bootstrap case, not a rotation to
       * protect.
       */
      const existing = findUserByEmail(store, org.id, normaliseEmail(email));
      const existingConsoleRole =
        existing !== null && hadConsoleAccess(store, existing.id) ? existing.role : undefined;
      const role = (roleFlag ?? existingConsoleRole ?? (hasAnyOwner(store, org.id) ? "admin" : "owner")) as
        | "owner"
        | "admin"
        | "member";

      const { password, generated } = await readPassword(argv);
      const user = await grantDashboardAccess(store, {
        orgId: org.id,
        email,
        password,
        role,
      });

      recordAudit(store, {
        orgId: org.id,
        actorLabel: "cli",
        action: sub === "create" ? "admin.create" : "admin.passwd",
        target: user.email,
        outcome: "ok",
        detail: { role },
      });

      out(`user : ${user.email}`);
      out(`role : ${user.role}`);
      if (generated) {
        out("");
        // Shown exactly once: only the scrypt hash is stored.
        out(`  ${password}`);
        out("");
        out("This is the only time the password is shown. Store it in a password manager.");
      } else {
        out("password set from stdin");
      }
      out("Existing sessions for this user have been signed out.");
      return;
    }

    if (sub === "list") {
      const rows = store.db
        .prepare(
          `SELECT email, role, password_hash IS NOT NULL AS can_sign_in, disabled_at, password_set_at
             FROM users WHERE org_id = ? ORDER BY role, email`,
        )
        .all(org.id) as Array<Record<string, unknown>>;
      if (rows.length === 0) out("(no users)");
      for (const r of rows) {
        const state = r["disabled_at"] !== null ? "disabled" : Number(r["can_sign_in"]) === 1 ? "sign-in" : "metered-only";
        out(`${String(r["email"]).padEnd(32)} ${String(r["role"]).padEnd(7)} ${state}`);
      }
      return;
    }

    if (sub === "disable" || sub === "enable") {
      const email = argv[1];
      if (email === undefined) throw new Error(`usage: fest admin ${sub} <email>`);
      const disabling = sub === "disable";
      const res = store.db
        .prepare(`UPDATE users SET disabled_at = ? WHERE org_id = ? AND email = ?`)
        .run(disabling ? Date.now() : null, org.id, normaliseEmail(email));
      if (Number(res.changes) === 0) throw new Error(`no such user: ${email}`);

      // Disabling has to take effect now, not at the next sign-in. A live
      // cookie outliving the account is the whole reason this command exists.
      if (disabling) {
        const user = store.db
          .prepare(`SELECT id FROM users WHERE org_id = ? AND email = ?`)
          .get(org.id, normaliseEmail(email)) as { id: string } | undefined;
        if (user !== undefined) revokeUserSessions(store, user.id);
      }
      recordAudit(store, {
        orgId: org.id,
        actorLabel: "cli",
        action: disabling ? "admin.disable" : "admin.enable",
        target: normaliseEmail(email),
        outcome: "ok",
      });
      out(`${disabling ? "disabled" : "enabled"} ${normaliseEmail(email)}`);
      return;
    }

    throw new Error(`unknown admin subcommand: ${sub}`);
  } finally {
    store.close();
  }
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

function printHelp(): void {
  out(
    "server operator:\n" +
      "  fest serve | migrate |\n" +
      "       seed [--requests N] [--hours N] [--reset | --clear] [--force] |\n" +
      "       token create <email> [name] | token list | token revoke <id> |\n" +
      "       admin create <email> [--role R] [--password-stdin] | admin list |\n" +
      "       admin passwd <email> | admin disable <email> | admin enable <email>\n" +
      "\n" +
      "developer (run on your own machine, no server env needed):\n" +
      "  fest login [--provider google|github] [--server <url>]\n" +
      "  fest whoami\n" +
      "  fest claude [gw] [-- claude args...]   (gw: force org credentials + gateway models)\n" +
      "  fest logout",
  );
}

async function cmdLogin(argv: readonly string[]): Promise<void> {
  const providerFlag = flagValue(argv, "provider") ?? "google";
  if (providerFlag !== "google" && providerFlag !== "github") {
    throw new Error("--provider must be google or github");
  }
  const serverFlag = flagValue(argv, "server");
  const serverUrl = serverFlag ?? (await readCliConfig())?.serverUrl;
  if (serverUrl === undefined) {
    throw new Error(
      "usage: fest login --server <url> [--provider google|github]\n(--server is required the first time)",
    );
  }
  await runLogin({ provider: providerFlag, serverUrl });
}

/**
 * Commands a developer runs on their own machine. Dispatched before
 * `loadConfig()` is ever called: a laptop has no reason to have any FEST_*
 * server env var set, and these commands must not imply otherwise.
 */
const CLIENT_COMMANDS = new Set(["login", "whoami", "claude", "logout"]);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "help";

  if (CLIENT_COMMANDS.has(cmd)) {
    switch (cmd) {
      case "login":
        await cmdLogin(argv.slice(1));
        return;
      case "whoami":
        await runWhoami();
        return;
      case "claude": {
        let claudeArgs = argv.slice(1);
        // `gw` is the one word this subcommand owns, and only before `--`:
        // `fest claude -- gw` still forwards `gw` to the child.
        const posture = claudeArgs[0] === "gw" ? "key" : "auto";
        if (posture === "key") claudeArgs = claudeArgs.slice(1);
        // `fest claude -- --resume` and `fest claude --resume` are both fine:
        // apart from `gw` this subcommand defines no flags of its own, so a
        // leading `--` is only ever there by convention and is stripped rather
        // than forwarded.
        if (claudeArgs[0] === "--") claudeArgs = claudeArgs.slice(1);
        await runClaude(claudeArgs, posture);
        return;
      }
      case "logout":
        await runLogout();
        return;
    }
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

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
    case "admin":
      await cmdAdmin(cfg, argv.slice(1));
      return;
    case "seed":
      await cmdSeed(cfg, argv.slice(1));
      return;
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

main().catch((err) => {
  process.stderr.write(`fest: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
