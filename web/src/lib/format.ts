/**
 * Presentation rules.
 *
 * These are not cosmetic helpers — several of them are the accounting rules
 * from docs/FRONTEND.md made unavoidable. In particular there is no function
 * here that will render a null cost as `$0.00`, because the difference between
 * "free" and "not priced" is the difference between a correct dashboard and a
 * confidently wrong one.
 */

import type { UsagePayload } from "../../../shared/types.ts";
import type { UsageTotalsWire } from "../../../shared/api.ts";

const nf = new Intl.NumberFormat("en-US");
const pct = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

export const num = (n: number): string => nf.format(n);

/** Compact token counts; a dashboard column has no room for 1,203,948,112. */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/**
 * A single row's cost. `null` is `n/a`, never `$0.00`.
 *
 * Four decimal places because a single cached Claude Code turn is routinely
 * under a cent, and rounding it to `$0.00` makes a real cost look like no cost.
 */
export function cost(usd: number | null): string {
  return usd === null || !Number.isFinite(usd) ? "n/a" : `$${usd.toFixed(4)}`;
}

/**
 * A cost TOTAL, which is a different thing from a cost.
 *
 * `pricedCostUsd` sums only the rows that could be priced, so whenever
 * `unpricedRequests > 0` it is a lower bound and must be shown as one. The
 * subscription count is never folded in: that usage was real and cost the org
 * nothing, and adding it as $0 would drag every average down.
 */
export function costTotal(t: UsageTotalsWire): string {
  const base = `$${t.pricedCostUsd.toFixed(4)}`;
  return t.unpricedRequests > 0 ? `≥ ${base} (+${t.unpricedRequests} n/a)` : base;
}

export const ratio = (r: number | null): string => (r === null ? "n/a" : pct.format(r));

export function ms(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "n/a";
  return v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)}s`;
}

export const contextTokens = (u: UsagePayload): number =>
  u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens;

export const cacheWriteTokens = (u: UsagePayload): number =>
  u.cacheWrite5mTokens + u.cacheWrite1hTokens;

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export const clock = (msEpoch: number): string => timeFmt.format(new Date(msEpoch));

export function when(msEpoch: number): string {
  const d = new Date(msEpoch);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? timeFmt.format(d) : `${dayFmt.format(d)} ${timeFmt.format(d)}`;
}

/** "in 42m" / "12m ago" — quota resets are only meaningful as a countdown. */
export function relative(msEpoch: number | null, now = Date.now()): string {
  if (msEpoch === null) return "n/a";
  const delta = msEpoch - now;
  const mins = Math.round(Math.abs(delta) / 60_000);
  const text = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return delta >= 0 ? `in ${text}` : `${text} ago`;
}

/** Human labels for the enum values the API hands back verbatim. */
export const ORIGIN_LABELS: Readonly<Record<string, string>> = {
  inbound_subscription: "Developer subscription",
  inbound_key: "Developer API key",
  fallback_server: "Server-held key",
  none: "No credential",
};

export const originLabel = (o: string): string => ORIGIN_LABELS[o] ?? o;

/** Unattributed usage surfaces as an empty id; name it, never hide it. */
export const userLabel = (id: string | null, email?: string | null): string =>
  email ?? (id === null || id === "" ? "unattributed" : id);

export const modelLabel = (m: string | null): string =>
  m === null || m === "" ? "unresolved" : m;
