/**
 * In-process fan-out of usage records to connected dashboards.
 *
 * Deliberately fed from the sink's FLUSH, not from `record()`: the request path
 * stays allocation-only, and a dashboard that is connected must never be able
 * to add work to a developer's in-flight stream. The cost is that "live" means
 * "within one flush interval" (250ms), which is indistinguishable from instant
 * to a human watching a feed.
 *
 * A subscriber that cannot keep up is DROPPED FROM, not buffered for. Growing a
 * buffer for a stalled browser tab would trade a developer's memory for a
 * dashboard's completeness; the feed is a tail, and the paged `/api/requests`
 * view is the authoritative history. Drops are counted so the gap is visible
 * rather than silent — the same rule the sink's queue follows.
 */

import type { UsageRecord } from "../../shared/types.ts";

export interface LiveSubscriber {
  /** Return false to signal "I am backed up, drop this rather than queue it". */
  (records: readonly UsageRecord[]): boolean;
}

export interface LiveBusStats {
  readonly subscribers: number;
  readonly published: number;
  readonly dropped: number;
}

export interface LiveBus {
  publish(records: readonly UsageRecord[]): void;
  subscribe(fn: LiveSubscriber): () => void;
  stats(): LiveBusStats;
}

export function createLiveBus(): LiveBus {
  const subscribers = new Set<LiveSubscriber>();
  let published = 0;
  let dropped = 0;

  return {
    publish(records: readonly UsageRecord[]): void {
      if (records.length === 0 || subscribers.size === 0) return;
      published += records.length;
      for (const fn of subscribers) {
        let accepted = false;
        try {
          accepted = fn(records);
        } catch {
          // A throwing subscriber is a broken socket, not our problem to retry.
          // Unsubscribe it so one bad tab cannot be tried again on every flush.
          subscribers.delete(fn);
          continue;
        }
        if (!accepted) dropped += records.length;
      }
    },

    subscribe(fn: LiveSubscriber): () => void {
      subscribers.add(fn);
      return () => void subscribers.delete(fn);
    },

    stats(): LiveBusStats {
      return { subscribers: subscribers.size, published, dropped };
    },
  };
}
