/**
 * A rolling window of recent requests, kept client-side for aggregation.
 *
 * The live screen answers "what is this gateway doing *now*" — by model, by
 * developer, by credential — which is a question about a moving window, not
 * about individual rows. So this keeps a pruned list of lightweight events and
 * lets the page roll them up, rather than keeping a display list.
 *
 * Only the fields the rollups need are retained. The wire rows carry a
 * credential trail and per-attempt reasoning that would multiply the memory
 * held for a five-minute window by a large factor and answer nothing this
 * screen asks.
 *
 * The window is seeded from `/api/requests` on mount, because SSE only pushes
 * what happens next: without a seed, opening the page during a quiet minute
 * shows an empty dashboard on a perfectly healthy gateway.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeedRowWire } from "../../../shared/api.ts";
import { isErrorStatus, type RequestStatus } from "../../../shared/types.ts";
import { cacheWriteTokens, contextTokens } from "../lib/format.ts";

export interface LiveEvent {
  readonly id: string;
  readonly at: number;
  readonly userId: string | null;
  readonly email: string | null;
  readonly model: string;
  readonly origin: string;
  readonly status: string;
  readonly pipeline: string;
  readonly costUsd: number | null;
  /** List-rate value, populated on subscription rows too. Never spend. */
  readonly notionalCostUsd: number | null;
  readonly subscription: boolean;
  readonly context: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly durationMs: number;
}

export interface RateBucket {
  readonly startMs: number;
  readonly count: number;
  readonly errors: number;
}

export interface LiveWindow {
  readonly events: readonly LiveEvent[];
  readonly buckets: readonly RateBucket[];
  readonly total: number;
  readonly errors: number;
  readonly perMinute: number;
  readonly errorRatio: number | null;
  readonly windowMs: number;
}

/** How many slices the sparkline is drawn in, whatever the window length. */
const BUCKETS = 60;

/**
 * The shared predicate, imported rather than re-spelled.
 *
 * This used to be a hand-written `status !== "ok"` in two places here, which
 * made it the only counter in the codebase that disagreed with
 * `NON_ERROR_STATUSES`: Claude Code's session-start warmup ping is recorded as
 * `preflight_refused` precisely so it is NOT a failure, and every server-side
 * count honours that. The headline "failing" figure did not, so it reported a
 * failure at the start of every session — directly above rollup boards, on the
 * same screen, that said otherwise.
 */
const isError = (e: LiveEvent): boolean => isErrorStatus(e.status as RequestStatus);

export function toEvent(row: FeedRowWire): LiveEvent {
  return {
    id: row.id,
    at: row.startedAt,
    userId: row.userId,
    email: null,
    model: row.servedModel ?? "",
    origin: row.credentialOrigin,
    status: row.status,
    pipeline: row.pipeline,
    costUsd: row.costUsd,
    notionalCostUsd: row.notionalCostUsd,
    subscription: row.costBasis === "subscription",
    context: contextTokens(row.usage),
    cacheWrite: cacheWriteTokens(row.usage),
    output: row.usage.outputTokens,
    durationMs: row.durationMs,
  };
}

export function useLiveWindow(windowMs: number): {
  window: LiveWindow;
  add: (rows: readonly FeedRowWire[]) => void;
  seed: (rows: readonly FeedRowWire[]) => void;
} {
  const [events, setEvents] = useState<readonly LiveEvent[]>([]);

  // A clock of its own, so the window still decays to empty when nothing is
  // arriving. Without it a gateway that went quiet would keep showing its last
  // busy minute for as long as the tab stayed open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2_000);
    return () => clearInterval(t);
  }, []);

  const windowRef = useRef(windowMs);
  windowRef.current = windowMs;

  const add = useCallback((rows: readonly FeedRowWire[]) => {
    if (rows.length === 0) return;
    const cutoff = Date.now() - windowRef.current;
    setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.id));
      const merged = [...prev];
      for (const row of rows) {
        if (!seen.has(row.id)) merged.push(toEvent(row));
      }
      return merged.filter((e) => e.at >= cutoff);
    });
  }, []);

  /** Same as `add`, but tolerant of the seed arriving after live rows have. */
  const seed = useCallback((rows: readonly FeedRowWire[]) => add(rows), [add]);

  const win = useMemo<LiveWindow>(() => {
    const cutoff = now - windowMs;
    const inWindow = events.filter((e) => e.at >= cutoff);

    const bucketMs = windowMs / BUCKETS;
    const base = Math.floor(now / bucketMs) * bucketMs;
    const counts = new Array<number>(BUCKETS).fill(0);
    const errs = new Array<number>(BUCKETS).fill(0);

    for (const e of inWindow) {
      const idx = BUCKETS - 1 - Math.floor((base - e.at) / bucketMs);
      if (idx < 0 || idx >= BUCKETS) continue;
      counts[idx] = (counts[idx] ?? 0) + 1;
      if (isError(e)) errs[idx] = (errs[idx] ?? 0) + 1;
    }

    const buckets: RateBucket[] = counts.map((c, i) => ({
      startMs: base - (BUCKETS - 1 - i) * bucketMs,
      count: c,
      errors: errs[i] ?? 0,
    }));

    const total = inWindow.length;
    const errors = inWindow.filter(isError).length;

    return {
      events: inWindow,
      buckets,
      total,
      errors,
      perMinute: total / (windowMs / 60_000),
      errorRatio: total === 0 ? null : errors / total,
      windowMs,
    };
  }, [events, now, windowMs]);

  return { window: win, add, seed };
}
