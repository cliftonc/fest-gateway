/**
 * Lean per-model rate lookup.
 *
 * Two rules carried over from the cost engine in fw-ai/fireconnect
 * (packages/setup-cli/lib/harnesses/claude/usage/pricing.mjs), both of which are
 * easy to get wrong and expensive to get wrong:
 *
 *  1. The token buckets are DISJOINT and priced at different rates. Cache reads
 *     are ~10% of the input rate; a 5-minute cache write is ~125% and a 1-hour
 *     write ~200%. Folding cache reads into input inflates a bill by an order of
 *     magnitude on a cache-heavy agent workload, which Claude Code is.
 *  2. An unknown model yields `null`, never an estimate. A guessed rate that
 *     looks plausible is worse than an honest "n/a", because nobody
 *     investigates a number that looks fine.
 *
 * Rates are USD per million tokens and WILL drift. They are deliberately a
 * small, legible table rather than a vendor API call: a gateway must not depend
 * on an external price service to serve a request.
 */

import type { UsagePayload, CostBasis } from "../../shared/types.ts";
import type { Cost } from "./cost.ts";

export interface ModelRate {
  readonly label: string;
  readonly inputPerMillion: number;
  readonly cacheReadPerMillion: number;
  readonly cacheWrite5mPerMillion: number;
  readonly cacheWrite1hPerMillion: number;
  readonly outputPerMillion: number;
}

/**
 * Build a rate from the base input/output pair using Anthropic's standard cache
 * multipliers, so a new model is one line rather than five numbers to get wrong.
 */
function rate(label: string, input: number, output: number): ModelRate {
  return {
    label,
    inputPerMillion: input,
    cacheReadPerMillion: input * 0.1,
    cacheWrite5mPerMillion: input * 1.25,
    cacheWrite1hPerMillion: input * 2.0,
    outputPerMillion: output,
  };
}

/**
 * Keyed by a normalised model family. Matching is prefix-based so dated
 * snapshots (`claude-opus-4-5-20260101`) resolve without a table entry each.
 */
const RATES: ReadonlyArray<readonly [string, ModelRate]> = [
  ["claude-opus-4-1", rate("Claude Opus 4.1", 15, 75)],
  ["claude-opus-4", rate("Claude Opus 4", 15, 75)],
  ["claude-opus-5", rate("Claude Opus 5", 15, 75)],
  ["claude-opus", rate("Claude Opus", 15, 75)],
  ["claude-sonnet-4-5", rate("Claude Sonnet 4.5", 3, 15)],
  ["claude-sonnet-4", rate("Claude Sonnet 4", 3, 15)],
  ["claude-sonnet-5", rate("Claude Sonnet 5", 3, 15)],
  ["claude-sonnet", rate("Claude Sonnet", 3, 15)],
  ["claude-3-7-sonnet", rate("Claude Sonnet 3.7", 3, 15)],
  ["claude-haiku-4-5", rate("Claude Haiku 4.5", 1, 5)],
  ["claude-haiku-4", rate("Claude Haiku 4", 1, 5)],
  ["claude-haiku", rate("Claude Haiku", 1, 5)],
  ["claude-3-5-haiku", rate("Claude Haiku 3.5", 0.8, 4)],
];

const WEB_SEARCH_PER_THOUSAND = 10;

/** Strip Claude Code's client-side context-window tag before matching. */
function normalise(model: string): string {
  return model.trim().toLowerCase().replace(/\[1m\]$/, "");
}

export function lookupRate(model: string | null | undefined): ModelRate | null {
  if (!model) return null;
  const id = normalise(model);
  // Longest prefix wins, so `claude-opus-4-1` beats `claude-opus`.
  let best: ModelRate | null = null;
  let bestLen = -1;
  for (const [prefix, r] of RATES) {
    if (id.startsWith(prefix) && prefix.length > bestLen) {
      best = r;
      bestLen = prefix.length;
    }
  }
  return best;
}

export interface PricedUsage {
  readonly cost: Cost;
  readonly basis: CostBasis;
  readonly rateLabel: string | null;
}

/**
 * Price a call.
 *
 * `postureIsSubscription` short-circuits to `basis: "subscription"` with a null
 * cost: the developer's own plan absorbed it, so there is no org spend to
 * report. We deliberately do not compute a notional list price here — a number
 * in a cost column gets summed eventually, no matter how it is labelled.
 */
export function priceUsage(
  model: string | null,
  usage: UsagePayload,
  postureIsSubscription: boolean,
): PricedUsage {
  if (postureIsSubscription) {
    return { cost: null, basis: "subscription", rateLabel: null };
  }

  const r = lookupRate(model);
  if (!r) return { cost: null, basis: "none", rateLabel: null };

  const perMillion =
    usage.inputTokens * r.inputPerMillion +
    usage.cacheReadTokens * r.cacheReadPerMillion +
    usage.cacheWrite5mTokens * r.cacheWrite5mPerMillion +
    usage.cacheWrite1hTokens * r.cacheWrite1hPerMillion +
    usage.outputTokens * r.outputPerMillion;

  const cost =
    perMillion / 1_000_000 + (usage.webSearches * WEB_SEARCH_PER_THOUSAND) / 1_000;

  return { cost, basis: "list", rateLabel: r.label };
}

/**
 * Fraction of context that came from cache. The single most actionable number
 * on a gateway dashboard: a collapsed cache hit rate is where both spend and
 * latency go, and it usually means something upstream is mangling
 * `cache_control`.
 */
export function cacheHitRatio(usage: UsagePayload): number | null {
  const context =
    usage.inputTokens + usage.cacheReadTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
  if (context <= 0) return null;
  return usage.cacheReadTokens / context;
}
