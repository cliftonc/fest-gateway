/**
 * A cluster worker's end of the IPC link.
 *
 * A worker is today's HTTP server minus the singletons: it relays, prices and
 * queues usage exactly as before, but its sink's batch goes to the primary
 * rather than into SQLite (see primary.ts for why there is one writer).
 */

import type { SinkStats, UsageSink } from "../ingest/sink.ts";
import { log } from "../log.ts";
import type { ToPrimary } from "./messages.ts";

export interface WorkerLink {
  /**
   * Hand a message to the primary. Throws synchronously only when the channel
   * is already gone, which is what lets the sink requeue a batch it could not
   * send; a failure after that is logged and counted as lost.
   */
  send(msg: ToPrimary): void;
  /**
   * Resolve once every sent message has left this process, or after
   * `timeoutMs`. `process.send` is asynchronous, so exiting straight after the
   * final flush would silently drop the batch that flush just sent.
   */
  drained(timeoutMs: number): Promise<void>;
  /** Sends the channel refused after accepting them. */
  lost(): number;
}

export function createWorkerLink(): WorkerLink {
  let pending = 0;
  let lost = 0;
  let waiters: Array<() => void> = [];

  const settle = (): void => {
    if (pending > 0) return;
    const ready = waiters;
    waiters = [];
    for (const w of ready) w();
  };

  return {
    send(msg: ToPrimary): void {
      if (process.send === undefined || !process.connected) {
        throw new Error("no IPC channel to the cluster primary");
      }
      pending += 1;
      process.send(msg, undefined, undefined, (err) => {
        pending -= 1;
        if (err !== null && err !== undefined) {
          lost += 1;
          log.warn("cluster IPC send failed", { t: msg.t, error: String(err).slice(0, 200), lost });
        }
        settle();
      });
    },
    drained(timeoutMs: number): Promise<void> {
      if (pending === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref();
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    lost: () => lost,
  };
}

/**
 * One honest set of numbers for a dashboard served by any worker.
 *
 * `written`, `trailErrors` and `lastFlushMs` are the writer's — they are the
 * ones about the store. Queue depth, drops and errors ADD: a record lost in
 * this worker's queue or on the IPC hop is as lost as one the writer dropped,
 * and the rule everywhere in Fest is that loss is never silent. The local part
 * is this worker's only; the others' local losses show on their own dashboards.
 */
export function mergeSinkStats(local: SinkStats, writer: SinkStats | null, ipcLost: number): SinkStats {
  if (writer === null) return { ...local, written: 0, writeErrors: local.writeErrors + ipcLost };
  return {
    queued: local.queued + writer.queued,
    written: writer.written,
    dropped: local.dropped + writer.dropped,
    writeErrors: local.writeErrors + ipcLost + writer.writeErrors,
    trailErrors: writer.trailErrors,
    lastFlushMs: writer.lastFlushMs,
  };
}

/** The worker's sink, reporting cluster-wide health through `stats()`. */
export function withWriterStats(
  sink: UsageSink,
  writer: () => SinkStats | null,
  ipcLost: () => number,
): UsageSink {
  return {
    record: (rec) => sink.record(rec),
    flush: () => sink.flush(),
    close: () => sink.close(),
    recent: (limit) => sink.recent(limit),
    stats: () => mergeSinkStats(sink.stats(), writer(), ipcLost()),
  };
}
