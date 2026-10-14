/**
 * A log-bucketed latency histogram: fixed memory, mergeable across processes,
 * and plain JSON so it crosses IPC as-is.
 *
 * Buckets grow by 2.5% each, so any percentile is within ~2.5% of the true
 * value — far finer than the noise between two bench runs. Values are
 * milliseconds; anything below 0.01ms lands in bucket 0.
 */

const GROWTH = 1.025;
const FLOOR_MS = 0.01;
const LOG_GROWTH = Math.log(GROWTH);

export interface Hist {
  /** bucket index → count, sparse. */
  b: Record<number, number>;
  n: number;
  sum: number;
  max: number;
}

export const emptyHist = (): Hist => ({ b: {}, n: 0, sum: 0, max: 0 });

const bucketOf = (v: number): number => (v <= FLOOR_MS ? 0 : Math.max(0, Math.ceil(Math.log(v / FLOOR_MS) / LOG_GROWTH)));
const upperOf = (i: number): number => FLOOR_MS * GROWTH ** i;

export function record(h: Hist, v: number): void {
  if (!Number.isFinite(v)) return;
  const x = Math.max(0, v);
  const i = bucketOf(x);
  h.b[i] = (h.b[i] ?? 0) + 1;
  h.n += 1;
  h.sum += x;
  if (x > h.max) h.max = x;
}

export function merge(into: Hist, from: Hist): Hist {
  for (const [k, c] of Object.entries(from.b)) {
    const i = Number(k);
    into.b[i] = (into.b[i] ?? 0) + c;
  }
  into.n += from.n;
  into.sum += from.sum;
  if (from.max > into.max) into.max = from.max;
  return into;
}

export const mergeAll = (hs: readonly Hist[]): Hist => hs.reduce((acc, h) => merge(acc, h), emptyHist());

/** `q` in [0, 1]. Null for an empty histogram — "no data", never zero. */
export function quantile(h: Hist, q: number): number | null {
  if (h.n === 0) return null;
  if (q >= 1) return h.max;
  const target = Math.max(1, Math.ceil(q * h.n));
  let seen = 0;
  for (const i of Object.keys(h.b).map(Number).sort((a, b) => a - b)) {
    seen += h.b[i]!;
    if (seen >= target) return Math.min(upperOf(i), h.max);
  }
  return h.max;
}

export const mean = (h: Hist): number | null => (h.n === 0 ? null : h.sum / h.n);

export interface Summary {
  n: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

export function summarize(h: Hist): Summary {
  return {
    n: h.n,
    p50: quantile(h, 0.5),
    p90: quantile(h, 0.9),
    p99: quantile(h, 0.99),
    max: h.n === 0 ? null : h.max,
    mean: mean(h),
  };
}
