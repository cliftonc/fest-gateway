/**
 * Per-model rate lookup and call pricing.
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
 * Rates come from the vendored litellm catalog in `prices/` — see that
 * directory for why they are a snapshot with a background refresh rather than a
 * live vendor call. This file replaced a hand-maintained 13-entry Claude table
 * that had drifted 3x on Opus 5; the drift is the argument for not hand-
 * maintaining rates.
 *
 * ── Two dollar figures, and why they are not interchangeable ─────────────────
 *
 * `cost` is ORG SPEND: what the organisation will be invoiced. It is null for a
 * subscription request, because the developer's own plan absorbed it and there
 * is no invoice.
 *
 * `notionalCost` is VALUE: what the same call would have cost at published API
 * rates, computed on every path including subscription. It exists because the
 * largest slice of Fest's traffic is otherwise invisible in money terms — a
 * team lead cannot see what their Max seats are actually delivering.
 *
 * They are separate fields, separate columns and separate UI stats precisely so
 * that "add them up" is never the path of least resistance. A notional figure
 * summed into spend is a fabricated invoice.
 */

import { contextTokens } from "../../shared/types.ts";
import type { UsagePayload, CostBasis } from "../../shared/types.ts";
import type { Cost } from "./cost.ts";
import { lookupRate, tierFor } from "./prices/table.ts";
import type { ModelRate } from "./prices/table.ts";

export { lookupRate } from "./prices/table.ts";
export type { ModelRate } from "./prices/table.ts";

export interface PricedUsage {
  /** Org spend. Null on the subscription path and for an unpriced model. */
  readonly cost: Cost;
  readonly basis: CostBasis;
  /**
   * List-rate value of this call, populated on EVERY path including
   * subscription. Null only when the model has no published rate at all.
   */
  readonly notionalCost: Cost;
  readonly rateLabel: string | null;
}

/**
 * Price one call at list rates.
 *
 * The tier is chosen from the call's own context size and service tier: a
 * long-context request bills entirely at the higher tier, which is how both
 * Anthropic and Google publish it, and is where Claude Code's 1M-context
 * sessions were previously understated by half.
 */
function listPrice(rate: ModelRate, usage: UsagePayload): number {
  const t = tierFor(rate, contextTokens(usage), usage.serviceTier);

  const perMillion =
    usage.inputTokens * t.inputPerMillion +
    usage.cacheReadTokens * t.cacheReadPerMillion +
    usage.cacheWrite5mTokens * t.cacheWrite5mPerMillion +
    usage.cacheWrite1hTokens * t.cacheWrite1hPerMillion +
    usage.outputTokens * t.outputPerMillion;

  // A model with no published search rate contributes nothing for searches
  // rather than borrowing another vendor's price.
  const search = rate.webSearchPerThousand === null
    ? 0
    : (usage.webSearches * rate.webSearchPerThousand) / 1_000;

  return perMillion / 1_000_000 + search;
}

/**
 * Price a call.
 *
 * `postureIsSubscription` still yields `basis: "subscription"` with a null
 * `cost` — that invariant is unchanged and load-bearing. What is new is that
 * `notionalCost` is populated anyway, so the value of subscription work is
 * recorded without ever entering a spend total.
 *
 * `provider` is litellm's provider key, needed on the substitute path where the
 * served model is a provider-native id. See `ADAPTER_PRICE_PROVIDERS`.
 */
export function priceUsage(
  model: string | null,
  usage: UsagePayload,
  postureIsSubscription: boolean,
  provider?: string | undefined,
): PricedUsage {
  const rate = lookupRate(model, provider);
  if (rate === null) {
    // Unpriced, not free — and unpriced on both figures. We do not know what
    // this model charges, so we do not know what it would have been worth.
    return {
      cost: null,
      basis: postureIsSubscription ? "subscription" : "none",
      notionalCost: null,
      rateLabel: null,
    };
  }

  const value = listPrice(rate, usage);

  if (postureIsSubscription) {
    return { cost: null, basis: "subscription", notionalCost: value, rateLabel: rate.label };
  }
  return { cost: value, basis: "list", notionalCost: value, rateLabel: rate.label };
}

/**
 * Fraction of context that came from cache. The single most actionable number
 * on a gateway dashboard: a collapsed cache hit rate is where both spend and
 * latency go, and it usually means something upstream is mangling
 * `cache_control`.
 */
export function cacheHitRatio(usage: UsagePayload): number | null {
  const context = contextTokens(usage);
  if (context <= 0) return null;
  return usage.cacheReadTokens / context;
}
