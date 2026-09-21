/**
 * The time range control, shared by every screen.
 *
 * Ranges are quantised to the minute rather than being `Date.now()` exactly.
 * With a raw timestamp every render produces a new query key, so TanStack
 * Query treats each one as a cache miss and the dashboard refetches everything
 * on every keystroke. Quantising makes the key stable for a minute at a time,
 * which is also as fresh as an hourly rollup can be.
 *
 * Note the server picks its own source from the range width — under two hours
 * it reads raw rows (exact percentiles), above that the hourly rollup
 * (interpolated). That is why "Last hour" is offered: it is the only way to
 * ask for exact latency numbers.
 */

import type { Range } from "./api.ts";

const MINUTE = 60_000;

export interface RangeOption {
  readonly id: string;
  readonly label: string;
  readonly ms: number;
}

export const RANGE_OPTIONS: readonly RangeOption[] = [
  { id: "1h", label: "Last hour", ms: 3_600_000 },
  { id: "24h", label: "Last 24 hours", ms: 24 * 3_600_000 },
  { id: "7d", label: "Last 7 days", ms: 7 * 86_400_000 },
  { id: "30d", label: "Last 30 days", ms: 30 * 86_400_000 },
];

export const DEFAULT_RANGE_ID = "24h";

export function rangeFor(id: string, now = Date.now()): Range {
  const option = RANGE_OPTIONS.find((o) => o.id === id) ?? RANGE_OPTIONS[1];
  const toMs = Math.ceil(now / MINUTE) * MINUTE;
  return { fromMs: toMs - (option?.ms ?? 24 * 3_600_000), toMs };
}

/** True when the server will answer this range from raw rows, not the rollup. */
export const isExactRange = (r: Range): boolean => r.toMs - r.fromMs <= 2 * 3_600_000;
