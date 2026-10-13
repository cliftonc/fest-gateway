/**
 * The cluster primary: `fest serve` with `FEST_WORKERS` > 1.
 *
 * It serves no HTTP. `node:cluster` accepts each connection here and hands the
 * socket to a worker, after which bytes flow between the client and that
 * worker directly — so the passthrough path's byte-for-byte rule is untouched,
 * and a stream is only ever as at-risk as the one worker relaying it.
 *
 * It is the ONLY process that writes metering. SQLite allows one writer at a
 * time, and a connection waiting for the lock sleeps on its own thread: if
 * every worker wrote its own batches, each would park the streams it relays
 * whenever another worker's transaction held the lock. Funnelling usage here
 * makes that wait structurally impossible, and keeps one JSONL trail rather
 * than N interleaving appenders. The primary also owns everything that must
 * run once: migrations (already applied by the caller), retention, the price
 * refresh, and `last_used_at`.
 *
 * Keep it small. It is the one process whose crash takes every worker with it.
 */

import cluster from "node:cluster";
import type { Worker } from "node:cluster";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { FestConfig } from "../config.ts";
import { createUsageSink } from "../ingest/sink.ts";
import type { SinkStats } from "../ingest/sink.ts";
import { log } from "../log.ts";
import type { Store } from "../store/db.ts";
import { startRetention, DEFAULT_RETENTION } from "../store/retention.ts";
import { createLastUsedTracker } from "../store/tokens.ts";
import { createRequestWriter } from "../store/write.ts";
import { startPriceRefresh, pricingOptionsFromEnv } from "../usage/prices/refresh.ts";
import { isToPrimary } from "./messages.ts";
import type { ToWorker } from "./messages.ts";

/** How a worker learns which org it serves without re-running bootstrap. */
export const ORG_ID_ENV = "FEST_CLUSTER_ORG_ID";

export interface PrimaryOptions {
  readonly cfg: FestConfig;
  /** Opened and migrated by the caller, before any worker exists. */
  readonly store: Store;
  readonly orgId: string;
  /** Printed once, when the first worker is listening. */
  readonly announce: () => void;
  /** Each worker's own drain grace; the primary waits a little longer. */
  readonly drainGraceMs: number;
}

/** Crash-loop guard: 1s, doubling per crash in the last minute, capped. */
const RESPAWN_BASE_MS = 1_000;
const RESPAWN_MAX_MS = 30_000;
const CRASH_WINDOW_MS = 60_000;
const STATS_EVERY_MS = 1_000;

export async function runPrimary(opts: PrimaryOptions): Promise<void> {
  const { cfg, store, orgId } = opts;

  const writer = createRequestWriter(store);
  const lastUsed = createLastUsedTracker(store);
  // Hourly, on a timer rather than at boot — see startRetention.
  const retention = startRetention(store, DEFAULT_RETENTION);

  const broadcast = (msg: ToWorker): void => {
    for (const w of Object.values(cluster.workers ?? {})) {
      if (w === undefined || !w.isConnected()) continue;
      try {
        w.send(msg);
      } catch {
        // A worker mid-exit. It is about to be respawned or shut down; either
        // way there is no one left in it to show the frame to.
      }
    }
  };

  // Workers price their own requests from the cache file; this only tells them
  // a newer one has landed.
  const priceRefresh = startPriceRefresh(pricingOptionsFromEnv(cfg.dbPath), () => broadcast({ t: "prices" }));

  await mkdir(dirname(cfg.usageLogPath), { recursive: true });
  const sink = createUsageSink({
    path: cfg.usageLogPath,
    // Same order as the single process: persist, then publish, so no dashboard
    // on any worker shows a row that then fails to persist.
    onBatch: (records) => {
      writer.writeBatch(orgId, records);
      broadcast({ t: "live", records });
    },
  });

  // The writer's health, pushed only when it changes.
  let lastStats = "";
  const sendStats = (to?: Worker): void => {
    const stats: SinkStats = sink.stats();
    const key = JSON.stringify(stats);
    if (to !== undefined) {
      to.send({ t: "stats", stats } satisfies ToWorker);
      return;
    }
    if (key === lastStats) return;
    lastStats = key;
    broadcast({ t: "stats", stats });
  };
  const statsTimer = setInterval(() => sendStats(), STATS_EVERY_MS);
  statsTimer.unref();

  cluster.setupPrimary({ serialization: "advanced" });

  cluster.on("message", (_worker, msg: unknown) => {
    if (!isToPrimary(msg)) return;
    if (msg.t === "usage") {
      for (const rec of msg.records) sink.record(rec);
    } else {
      lastUsed.touch(msg.tokenId);
    }
  });

  cluster.on("online", (w) => {
    try {
      sendStats(w);
    } catch {
      // Gone already; the exit handler deals with it.
    }
  });

  let announced = false;
  cluster.on("listening", () => {
    if (announced) return;
    announced = true;
    opts.announce();
  });

  let shuttingDown = false;
  const crashes: number[] = [];

  const fork = (): void => {
    cluster.fork({ [ORG_ID_ENV]: orgId });
  };

  cluster.on("exit", (w, code, signal) => {
    if (shuttingDown) return;
    const now = Date.now();
    crashes.push(now);
    while (crashes.length > 0 && now - (crashes[0] ?? now) > CRASH_WINDOW_MS) crashes.shift();
    const delay = Math.min(RESPAWN_MAX_MS, RESPAWN_BASE_MS * 2 ** (crashes.length - 1));
    log.warn("worker exited; respawning", { worker: w.id, code, signal, inMs: delay });
    setTimeout(() => {
      if (!shuttingDown) fork();
    }, delay).unref();
  });

  for (let i = 0; i < cfg.workers; i += 1) fork();
  log.info("cluster primary started", { workers: cfg.workers, pid: process.pid });

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal, workers: Object.keys(cluster.workers ?? {}).length });

    const live = (): Worker[] =>
      Object.values(cluster.workers ?? {}).filter((w): w is Worker => w !== undefined && !w.isDead());

    // Each worker runs its own drain. A terminal's Ctrl-C has already sent them
    // SIGINT through the process group; the explicit signal covers a container
    // stop, which signals only this pid. The workers' handlers are idempotent.
    for (const w of live()) w.process.kill("SIGTERM");

    const finish = (): void => {
      clearInterval(statsTimer);
      // Their final batches arrived before their exits, so this drains them.
      void sink.close().then(() => {
        retention.stop();
        priceRefresh.stop();
        lastUsed.stop();
        store.close();
        log.info("drained", { sink: sink.stats() });
        process.exit(0);
      });
    };

    const check = setInterval(() => {
      if (live().length > 0) return;
      clearInterval(check);
      clearTimeout(forced);
      finish();
    }, 50);

    // A worker that outlives its own grace is wedged; do not let it hold the
    // metering of every other worker hostage.
    const forced = setTimeout(() => {
      clearInterval(check);
      for (const w of live()) {
        log.warn("worker did not drain; killing", { worker: w.id });
        w.process.kill("SIGKILL");
      }
      finish();
    }, opts.drainGraceMs + 3_000);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
