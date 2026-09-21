/**
 * Usage record sink: bounded queue in front of batched appends.
 *
 * `record()` is called from the request path, so it is allocation-only: push
 * onto an array and return. No I/O, no JSON, no pricing, no awaiting. Pricing
 * happens in the flush, where a slow lookup cannot add latency to a stream.
 *
 * On overload the queue drops the OLDEST record and increments a counter. That
 * is deliberate: we degrade the metric rather than the product. The counter is
 * exposed so the loss can never be silent — a dashboard that quietly
 * under-reports is worse than one that admits it dropped 4,102 records.
 *
 * Phase 1 writes JSONL. The queue/flush seam is where SQLite lands in Phase 2
 * without the request path changing.
 */

import { appendFile } from "node:fs/promises";
import type { UsageRecord } from "../../shared/types.ts";
import { log } from "../log.ts";

export interface SinkStats {
  readonly queued: number;
  readonly written: number;
  readonly dropped: number;
  readonly writeErrors: number;
  /** Failures of the JSONL trail specifically. Not data loss on its own. */
  readonly trailErrors: number;
  readonly lastFlushMs: number | null;
}

export interface UsageSink {
  /** Synchronous, non-throwing, no I/O. Safe to call from the hot path. */
  record(rec: UsageRecord): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  stats(): SinkStats;
  /** Most recent records, newest first. Backs the Phase 1 admin endpoint. */
  recent(limit?: number): readonly UsageRecord[];
}

export interface SinkOptions {
  readonly path: string;
  readonly flushMs?: number;
  readonly maxQueue?: number;
  readonly maxBatch?: number;
  /** Size of the in-memory ring used by `recent()`. */
  readonly ringSize?: number;
  /**
   * Durable persistence for a batch — the system of record.
   *
   * Called inside the flush, never on the request path, so a slow insert
   * cannot add latency to a stream. Must be synchronous and should not throw;
   * if it does, the batch is requeued once.
   */
  readonly onBatch?: ((records: readonly UsageRecord[]) => void) | undefined;
}

export function createUsageSink(opts: SinkOptions): UsageSink {
  const flushMs = opts.flushMs ?? 250;
  const maxQueue = opts.maxQueue ?? 10_000;
  const maxBatch = opts.maxBatch ?? 200;
  const ringSize = opts.ringSize ?? 500;

  let queue: UsageRecord[] = [];
  const ring: UsageRecord[] = [];
  let written = 0;
  let dropped = 0;
  let writeErrors = 0;
  let trailErrors = 0;
  let lastFlushMs: number | null = null;
  /**
   * The in-flight flush, if any. Held as a promise rather than a boolean so
   * that `await flush()` awaits the *actual work* even when a fire-and-forget
   * flush is already running. With a boolean guard, `close()` could return
   * while a flush was mid-append and silently drop whatever was still queued.
   */
  let inFlight: Promise<void> | null = null;
  let closed = false;

  let timer: NodeJS.Timeout | null = setInterval(() => {
    void flush();
  }, flushMs);
  // Never hold the process open just to flush metrics.
  timer.unref();

  function flush(): Promise<void> {
    // Overlapping flushes would interleave appends, so callers join the
    // in-flight one instead of starting a second.
    if (inFlight) return inFlight;
    if (queue.length === 0) return Promise.resolve();
    inFlight = doFlush().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function doFlush(): Promise<void> {
    const startedAt = Date.now();
    const batch = queue.splice(0, maxBatch);

    // The store is the system of record, so it goes first and its outcome
    // decides whether the batch is safe to let go of.
    let persisted = true;
    if (opts.onBatch !== undefined) {
      try {
        opts.onBatch(batch);
      } catch (err) {
        persisted = false;
        writeErrors += 1;
        log.warn("usage store write failed", { error: String(err).slice(0, 200), writeErrors });
      }
    }

    // The JSONL file is a convenience trail, not the record. Its failure is
    // logged and counted but never requeues the batch: retrying purely for the
    // trail's sake would re-run onBatch and duplicate rows in the store.
    try {
      const payload = batch.map((r) => JSON.stringify(r)).join("\n") + "\n";
      await appendFile(opts.path, payload, "utf8");
    } catch (err) {
      trailErrors += 1;
      log.warn("usage trail write failed", { error: String(err).slice(0, 200), trailErrors });
    }

    if (persisted) {
      written += batch.length;
    } else if (queue.length + batch.length <= maxQueue) {
      // Requeue once at the front. Beyond that, drop rather than grow without
      // bound against a persistently failing store.
      queue = [...batch, ...queue];
    } else {
      dropped += batch.length;
    }

    lastFlushMs = Date.now() - startedAt;
  }

  return {
    record(rec: UsageRecord): void {
      if (closed) return;
      if (queue.length >= maxQueue) {
        queue.shift();
        dropped += 1;
      }
      queue.push(rec);
      ring.push(rec);
      if (ring.length > ringSize) ring.shift();
      // Size trigger, so a burst is not held for the full timer interval.
      if (queue.length >= maxBatch) void flush();
    },
    flush,
    async close(): Promise<void> {
      closed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Let any fire-and-forget flush settle first. Joining it would make no
      // progress on our own backlog, because it has already taken its batch —
      // which would make the no-progress check below break out immediately and
      // silently discard the remainder.
      if (inFlight) await inFlight;

      // Now drain in fresh batches. A batch that fails to shrink the queue
      // means the disk is not accepting writes; stop rather than spin forever.
      while (queue.length > 0) {
        const before = queue.length;
        await flush();
        if (queue.length >= before) break;
      }
    },
    stats(): SinkStats {
      return { queued: queue.length, written, dropped, writeErrors, trailErrors, lastFlushMs };
    },
    recent(limit = 100): readonly UsageRecord[] {
      return ring.slice(-limit).reverse();
    },
  };
}
