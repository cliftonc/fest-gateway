/**
 * Retention.
 *
 * Raw `requests` rows carry per-developer detail — who, when, which session —
 * so they are the privacy-bearing part of the system and they age out. The
 * hourly rollups are aggregate and survive far longer, which is what lets a
 * dashboard show a year of trends without keeping a year of surveillance.
 *
 * Deletes run in bounded batches. A single unbounded `DELETE` would hold the
 * write lock for as long as it takes, and on a single-writer SQLite that means
 * stalling the metering flush — and therefore the proxy's own queue — behind
 * housekeeping.
 */

import type { Store } from "./db.ts";
import { sweepSessions } from "../auth/session.ts";
import { log } from "../log.ts";

export interface RetentionPolicy {
  /** Raw per-request rows. Privacy-bearing; the short one. */
  readonly requestDays: number;
  /** Aggregate rollups. Safe to keep much longer. */
  readonly rollupDays: number;
  /** Rows per DELETE statement, to bound how long the write lock is held. */
  readonly batchSize?: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  requestDays: 30,
  rollupDays: 400,
  batchSize: 5_000,
};

export interface RetentionResult {
  readonly requestsDeleted: number;
  readonly rollupsDeleted: number;
}

export function runRetention(
  store: Store,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now = Date.now(),
): RetentionResult {
  const batchSize = policy.batchSize ?? 5_000;
  const requestCutoff = now - policy.requestDays * 86_400_000;
  const rollupCutoff = now - policy.rollupDays * 86_400_000;

  // Delete by `seq` rather than by timestamp directly: seq is the primary key,
  // so the subselect is an index scan and the delete is a rowid lookup.
  const delRequests = store.db.prepare(
    `DELETE FROM requests WHERE seq IN (
       SELECT seq FROM requests WHERE started_at < ? ORDER BY seq LIMIT ?
     )`,
  );
  const delRollups = store.db.prepare(
    `DELETE FROM usage_hourly WHERE hour_start < ?`,
  );

  let requestsDeleted = 0;
  for (;;) {
    // One transaction per batch, so other writers get a turn between batches.
    const deleted = store.transaction(() => Number(delRequests.run(requestCutoff, batchSize).changes));
    requestsDeleted += deleted;
    if (deleted < batchSize) break;
  }

  const rollupsDeleted = store.transaction(() => Number(delRollups.run(rollupCutoff).changes));

  if (requestsDeleted > 0 || rollupsDeleted > 0) {
    log.info("retention swept", {
      requestsDeleted,
      rollupsDeleted,
      requestDays: policy.requestDays,
      rollupDays: policy.rollupDays,
    });
  }
  return { requestsDeleted, rollupsDeleted };
}

/**
 * Hourly sweep. Unref'd so housekeeping never holds the process open, and run
 * on a timer rather than at boot so a restart loop cannot turn into a delete
 * loop.
 */
export function startRetention(
  store: Store,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  intervalMs = 3_600_000,
): { stop(): void } {
  const timer = setInterval(() => {
    try {
      runRetention(store, policy);
      // Dead dashboard sessions ride the same sweep. They are not governed by
      // the retention policy — an expired session hash proves nothing, and the
      // record of who signed in lives in the audit log — so they are simply
      // deleted once they can no longer authenticate anything.
      const sessions = sweepSessions(store);
      if (sessions > 0) log.info("sessions swept", { deleted: sessions });
    } catch (err) {
      // Housekeeping must never take the gateway down.
      log.warn("retention failed", { error: String(err).slice(0, 200) });
    }
  }, intervalMs);
  timer.unref();
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
