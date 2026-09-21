/**
 * SQLite handle, pragmas, and forward-only migrations.
 *
 * ── The synchronous-API constraint, which is load-bearing ────────────────────
 *
 * `node:sqlite`'s `DatabaseSync` is exactly what it says: EVERY statement runs
 * on the main thread and blocks the event loop for its full duration. In a
 * process whose day job is relaying long-lived streaming HTTP responses, that
 * is normally disqualifying — a 40ms dashboard aggregate would stall every
 * in-flight proxied stream by 40ms, and Claude Code users would see it as
 * stutter in their terminal.
 *
 * It is acceptable here only because of a structural rule: THE REQUEST HOT PATH
 * NEVER TOUCHES THIS DATABASE. Identity lookups are served from an in-memory
 * cache, and usage is handed to a queue that batches into one transaction well
 * off the request path (see server/ingest/sink.ts). The only synchronous
 * queries are the metering writer's batch and the dashboard's own requests.
 *
 * So: if you are about to add a `store.db.prepare(...)` call inside a proxied
 * request's lifecycle, don't. Move it behind the queue, or move the database to
 * a worker thread first. This comment is the guardrail.
 *
 * ── Pragmas ─────────────────────────────────────────────────────────────────
 *
 * WAL is the one that matters. Under the default rollback journal a writer
 * excludes all readers, so a dashboard query could block the metering writer
 * (and vice versa) — and because the API is synchronous, "blocked" means the
 * whole process is parked, streams included. WAL lets readers and the single
 * writer proceed concurrently, which is precisely the shape of this workload:
 * one batching writer, several bursty readers.
 *
 * Note: depending on Node version, importing `node:sqlite` may print an
 * ExperimentalWarning. It is expected; we deliberately do not suppress it
 * process-wide, because doing so would also hide unrelated warnings.
 */

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";

export interface Store {
  readonly db: DatabaseSync;
  /** Runs fn inside BEGIN IMMEDIATE / COMMIT, rolling back on throw. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

export function openStore(path: string): Store {
  const db = new DatabaseSync(path);

  // Order matters: WAL first so the journal switch happens before anything
  // else writes, and busy_timeout last so it covers the rest of the session.
  db.exec("PRAGMA journal_mode = WAL");
  // NORMAL, not FULL: we fsync at checkpoints rather than every commit. The
  // exposure is losing the last few hundred milliseconds of metering on an OS
  // crash, which is an acceptable trade for not fsyncing per batch. Metering is
  // observability, not ledger.
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Another process (a backup, a CLI) can hold the write lock briefly; wait
  // rather than throwing SQLITE_BUSY straight into the caller.
  db.exec("PRAGMA busy_timeout = 5000");

  /**
   * NOT RE-ENTRANT. SQLite has no nested transactions without SAVEPOINT, and
   * silently flattening a nested call would mean an inner "rollback" that
   * actually discards the outer caller's work. We detect and throw instead:
   * a loud error at development time beats a partially-applied batch in
   * production.
   */
  let depth = 0;

  const store: Store = {
    db,
    transaction<T>(fn: () => T): T {
      if (depth > 0) {
        throw new Error("Store.transaction is not re-entrant; flatten the call or use SAVEPOINT");
      }
      depth = 1;
      // BEGIN IMMEDIATE, not BEGIN: a deferred transaction takes the write
      // lock at the first write, so contention surfaces halfway through a
      // batch where we would have to unwind. IMMEDIATE takes it up front and
      // lets busy_timeout do the waiting before we have done any work.
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch (rollbackErr) {
          // A failed rollback must not mask the original error.
          log.warn("store rollback failed", { err: String(rollbackErr) });
        }
        throw err;
      } finally {
        depth = 0;
      }
    },
    close(): void {
      db.close();
    },
  };

  return store;
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/** Numeric prefix of a migration filename, e.g. "007-add-x.sql" → 7. */
function migrationVersion(file: string): number {
  const match = /^(\d+)/.exec(file);
  return match ? Number(match[1]) : Number.NaN;
}

/**
 * Apply every migration newer than `PRAGMA user_version`.
 *
 * Forward-only, by design and with precedent: there are no down migrations
 * anywhere in Fest. Reversing a schema change correctly requires the old data
 * to still exist, which a destructive migration by definition destroyed, so a
 * "down" script gives false confidence. The rollback story is restoring a
 * volume snapshot, which is also the only story that survives a bad deploy that
 * corrupted rows rather than columns.
 *
 * Idempotent: a second call sees user_version already at the highest prefix and
 * applies nothing.
 */
export function migrate(store: Store): { applied: number; version: number } {
  const current = userVersion(store.db);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    // Sort by filename, not by parsed number: the numeric prefixes are
    // zero-padded, so lexical order is numeric order, and a filename that
    // sorts oddly is a naming bug we want to see rather than paper over.
    .sort();

  let version = current;
  let applied = 0;

  for (const file of files) {
    const fileVersion = migrationVersion(file);
    if (!Number.isInteger(fileVersion)) {
      throw new Error(`migration ${file} has no numeric prefix`);
    }
    if (fileVersion <= current) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    // Each file in its own transaction: SQLite applies DDL transactionally, so
    // a syntax error in migration 3 leaves 1 and 2 committed and the version
    // at 2 — a retry after fixing the file resumes from exactly there.
    store.transaction(() => {
      store.db.exec(sql);
    });
    applied += 1;
    version = fileVersion;
  }

  if (version !== current) {
    // user_version cannot be parameterised, hence the interpolation; the value
    // came from a filename we just proved is an integer.
    store.db.exec(`PRAGMA user_version = ${version}`);
    log.info("store migrated", { from: current, to: version, applied });
  }

  return { applied, version };
}
