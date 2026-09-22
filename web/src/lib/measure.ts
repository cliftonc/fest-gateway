/**
 * What a magnitude on the Live screen is measured in.
 *
 * The screen can draw the same window on three sets of books: raw throughput,
 * what the org is billed, and what the work would be worth at published API
 * rates. They are not interchangeable views of one number — a team on Max seats
 * shows real tokens, near-zero billed and a large value, and all three are true
 * at once. So the switch changes the unit, and every widget on the page moves
 * with it rather than leaving one figure behind in the old one.
 *
 * WHY A TALLY AND NOT A NUMBER
 *
 * A bare number cannot carry "this understates reality". Two of the three
 * measures go a lower bound the moment a row cannot be priced, and `format.ts`
 * exists precisely so that a lower bound is never rendered as an exact figure.
 * So the unit passed between the page and its widgets is an accumulator, and
 * bar width, sort key, formatted string, axis label and every empty state are
 * derived from it. A pre-formatted string alongside a raw value would be two
 * fields to keep in step, and a stale pair — a width from one measure, a label
 * from another — is undetectable by eye.
 *
 * The accounting rules themselves are written down once, in `tallyAdd`. This is
 * not tidiness: `useLiveWindow` hand-wrote its own copy of "what counts as an
 * error" and spent however long disagreeing with the server about it.
 */

import { lowerBound, tokens, usd } from "./format.ts";

export type Measure = "tokens" | "billed" | "value";

/** Shared with nothing — unlike the theme, there is no pre-paint script. */
export const MEASURE_STORAGE_KEY = "fest-live-measure";

export const MEASURE_OPTIONS: readonly { id: Measure; label: string; hint: string }[] = [
  { id: "tokens", label: "Tokens", hint: "Raw throughput: context, cache writes and output." },
  {
    id: "billed",
    label: "Billed $",
    hint: "What the org is charged. Usage absorbed by a developer's own subscription is excluded.",
  },
  {
    id: "value",
    label: "Value $",
    hint: "What this work would cost at published API rates, subscription usage included.",
  },
];

/**
 * The structural subset of `LiveEvent` the measures need.
 *
 * Declared here rather than imported so this module owes nothing to the hook
 * layer, which keeps it importable by `node --test` — and lets its tests be
 * written against plain literals instead of wire rows.
 */
export interface MeasurableEvent {
  readonly subscription: boolean;
  readonly costUsd: number | null;
  readonly notionalCostUsd: number | null;
  readonly context: number;
  readonly cacheWrite: number;
  readonly output: number;
}

/**
 * Every magnitude a row can be drawn at, on all three books at once, plus the
 * counts that make two of them lower bounds.
 */
export interface MeasureTally {
  context: number;
  cacheWrite: number;
  output: number;
  /** Priced, non-subscription rows only. */
  billedUsd: number;
  /** Non-subscription rows with no price. What makes `billedUsd` a bound. */
  billedUnpriced: number;
  /** Counted, never priced. Shown in the tooltip so a zero can explain itself. */
  subscriptionRequests: number;
  /** ALL rows, subscription included. Runs on its own books by design. */
  valueUsd: number;
  valueUnpriced: number;
}

export function emptyTally(): MeasureTally {
  return {
    context: 0,
    cacheWrite: 0,
    output: 0,
    billedUsd: 0,
    billedUnpriced: 0,
    subscriptionRequests: 0,
    valueUsd: 0,
    valueUnpriced: 0,
  };
}

/**
 * Fold one event in. Mutating, because this runs once per event per rollup on
 * every frame the window changes.
 *
 * The two rules that matter, and the reason they live here and nowhere else:
 *
 *  - Subscription work is NOT $0 billed, it is not priced at all. It is skipped
 *    entirely rather than added as zero, and it does not count as unpriced
 *    either — an absorbed request is not a pricing failure.
 *  - Value takes every row, subscription included. That is the whole point of
 *    it being a separate set of books.
 */
export function tallyAdd(t: MeasureTally, e: MeasurableEvent): void {
  t.context += e.context;
  t.cacheWrite += e.cacheWrite;
  t.output += e.output;

  if (e.subscription) {
    t.subscriptionRequests += 1;
  } else if (e.costUsd === null) {
    t.billedUnpriced += 1;
  } else {
    t.billedUsd += e.costUsd;
  }

  if (e.notionalCostUsd === null) t.valueUnpriced += 1;
  else t.valueUsd += e.notionalCostUsd;
}

/** Fold one tally into another, for the "and the board as a whole?" question. */
export function tallyMerge(into: MeasureTally, from: MeasureTally): void {
  into.context += from.context;
  into.cacheWrite += from.cacheWrite;
  into.output += from.output;
  into.billedUsd += from.billedUsd;
  into.billedUnpriced += from.billedUnpriced;
  into.subscriptionRequests += from.subscriptionRequests;
  into.valueUsd += from.valueUsd;
  into.valueUnpriced += from.valueUnpriced;
}

export const tallyTokens = (t: MeasureTally): number => t.context + t.cacheWrite + t.output;

/** What the bar is as long as and the rows are sorted by. Never a string. */
export function magnitude(t: MeasureTally, m: Measure): number {
  switch (m) {
    case "tokens":
      return tallyTokens(t);
    case "billed":
      return t.billedUsd;
    case "value":
      return t.valueUsd;
  }
}

/** True when the magnitude understates what actually happened. */
export function isLowerBound(t: MeasureTally, m: Measure): boolean {
  switch (m) {
    case "tokens":
      return false;
    case "billed":
      return t.billedUnpriced > 0;
    case "value":
      return t.valueUnpriced > 0;
  }
}

/**
 * A magnitude, rendered. `1.2M` / `≥ $0.0143` / `≥ ~$0.42`.
 *
 * The `~` sits inside the `≥`, matching `notionalTotal`, so the page reads the
 * same way wherever a notional figure appears.
 */
export function formatAmount(v: number, m: Measure, bound = false): string {
  switch (m) {
    case "tokens":
      return tokens(Math.round(v));
    case "billed":
      return lowerBound(usd(v), bound ? 1 : 0);
    case "value":
      return lowerBound(`~${usd(v)}`, bound ? 1 : 0);
  }
}

export const formatTally = (t: MeasureTally, m: Measure): string =>
  formatAmount(magnitude(t, m), m, isLowerBound(t, m));

/**
 * Ranking, with a full tiebreak chain — and the chain is not decoration.
 *
 * In billed mode on a gateway where everyone is on their own subscription,
 * EVERY magnitude is 0 and a magnitude-only comparator ties on every pair.
 * `Array.prototype.sort` is stable, so the order would fall back to insertion
 * order, which is first-seen-event order, which reshuffles every time the
 * window rolls an event off the front. `RollupBoard` animates rank changes with
 * a transform, so that board would visibly churn while nothing was happening.
 *
 * Tokens as the first tiebreak also means the all-zero board keeps a meaningful
 * order — and a model keeps its colour — instead of an arbitrary one.
 */
export function compareByMeasure(
  m: Measure,
): (a: { key: string; requests: number; tally: MeasureTally }, b: { key: string; requests: number; tally: MeasureTally }) => number {
  return (a, b) =>
    magnitude(b.tally, m) - magnitude(a.tally, m) ||
    tallyTokens(b.tally) - tallyTokens(a.tally) ||
    b.requests - a.requests ||
    a.key.localeCompare(b.key);
}

/** The rollup boards' header caption. */
export function unitCaption(m: Measure): string {
  switch (m) {
    case "tokens":
      return "total tokens";
    case "billed":
      return "billed spend";
    case "value":
      return "value at list rates";
  }
}

/** The pulse's axis caption stem: "… per 5s". */
export function unitShort(m: Measure): string {
  switch (m) {
    case "tokens":
      return "tokens";
    case "billed":
      return "billed $";
    case "value":
      return "value $";
  }
}

/** The headline rate figure. A rate, like every other figure in that row. */
export function rateLabels(m: Measure): { label: string; note: string } {
  switch (m) {
    case "tokens":
      return { label: "Tokens", note: "per minute" };
    case "billed":
      return { label: "Billed", note: "per minute, org spend" };
    case "value":
      return { label: "Value", note: "per minute, at list rates" };
  }
}

/**
 * Why a magnitude is zero while traffic is not.
 *
 * Both the board and the pulse already guard their divisions, so a
 * subscription-only window in billed mode renders cleanly — as a flat strip and
 * a row of empty bars, which is indistinguishable from an idle gateway. That is
 * the failure worth fixing: not a crash, a lie told quietly. Returns null when
 * there is nothing to explain, so a caller can render it unconditionally.
 */
export function zeroReason(t: MeasureTally, m: Measure, requests: number): string | null {
  if (requests === 0 || m === "tokens" || magnitude(t, m) > 0) return null;
  if (m === "billed") {
    if (t.subscriptionRequests === requests) {
      return "All traffic in this window ran on developer subscriptions — no org spend.";
    }
    if (t.billedUnpriced > 0) return "Nothing in this window could be priced.";
    return "No org spend in this window.";
  }
  return "No published rates for the models in this window.";
}
