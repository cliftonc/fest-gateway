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
 *
 * The `≥` carries that on its own; the count of unpriced requests used to be
 * spelled out next to it and was just noise on a dashboard read at a glance.
 * Dropping the `≥` too would be the real mistake — it presents a lower bound as
 * an exact figure.
 */
export function costTotal(
  t: Pick<UsageTotalsWire, "pricedCostUsd" | "unpricedRequests">,
): string {
  const base = `$${t.pricedCostUsd.toFixed(4)}`;
  return t.unpricedRequests > 0 ? `≥ ${base}` : base;
}

/**
 * Notional VALUE — what usage would have cost at published API rates, with
 * subscription work included.
 *
 * A third thing again, and the reason it gets its own function rather than an
 * argument to `costTotal`: `pricedCostUsd` is an invoice, this is what the work
 * was worth. Prefixed with `~` and never rendered without a label saying so,
 * because a bare dollar figure on a dashboard is read as money owed. Never add
 * it to a spend total — a team on Max seats shows $0 spend and a large figure
 * here, and both are true.
 */
export function notionalTotal(
  t: Pick<UsageTotalsWire, "notionalCostUsd" | "notionalUnpricedRequests">,
): string {
  const base = `~$${t.notionalCostUsd.toFixed(2)}`;
  return t.notionalUnpricedRequests > 0 ? `≥ ${base}` : base;
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

/**
 * A person, as a person.
 *
 * Unattributed usage surfaces as an empty id; it is named, never hidden.
 *
 * The domain is dropped because on a self-hosted install everyone shares it,
 * so it is a column of identical text. An opaque `usr_…` id is not a name: it
 * is shown truncated, because it is only there to tell two unknown callers
 * apart, and at full length it crowds out everything else on the row.
 */
export function personLabel(id: string | null, email?: string | null): string {
  if (email !== null && email !== undefined && email !== "") return email.replace(/@.*$/, "");
  if (id === null || id === "") return "unattributed";
  return id.length > 16 ? `${id.slice(0, 14)}…` : id;
}

/**
 * A model id, shortened to the part that identifies it.
 *
 * Routed providers namespace their ids — `accounts/fireworks/models/kimi-k2p7-code`
 * — and the prefix is identical for every model from that provider, so it is a
 * column of repeated text pushing the distinguishing part out of view. The full
 * id stays available as a tooltip wherever this is used.
 */
export const modelLabel = (m: string | null): string =>
  m === null || m === "" ? "unresolved" : (m.split("/").pop() ?? m);
