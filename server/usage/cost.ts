/**
 * Nullable cost algebra.
 *
 * `null` means "no dollar figure applies or is available". It does NOT mean
 * zero, and the distinction is load-bearing in two different ways:
 *
 *  - A model with no rate in our table is *unpriced*, not free. Reporting it as
 *    $0 understates spend, which is the failure mode this module exists to
 *    prevent.
 *  - A request served by a developer's own subscription has no marginal dollar
 *    cost to the org at all. Its notional list price is not spend and must
 *    never be added to a spend total.
 *
 * So addition propagates null: any unpriceable component poisons the total, and
 * the UI is expected to render "$X (+N n/a)" rather than a confidently wrong
 * number. Callers that want a partial sum must count the unpriced rows
 * separately — see `sumCosts`.
 *
 * Adapted from the cost accounting in fw-ai/fireconnect
 * (packages/setup-cli/lib/harnesses/claude/usage/cost.mjs), which arrived at
 * the same null-propagating rule the hard way.
 */

export type Cost = number | null;

/** Add two costs. Null propagates: an unknown component makes the sum unknown. */
export function addCost(a: Cost, b: Cost): Cost {
  if (a === null || b === null) return null;
  return a + b;
}

export interface CostSum {
  /** Sum of the priced entries only. */
  readonly priced: number;
  /** How many entries had no price. Non-zero means `priced` is a lower bound. */
  readonly unpricedCount: number;
  /** Null when anything was unpriced, so a caller cannot use it by accident. */
  readonly total: Cost;
}

/**
 * Sum a list of costs, keeping the unpriced count so a dashboard can be honest
 * ("$12.3456 (+3 n/a)") instead of silently dropping rows the way SQL `SUM`
 * does with NULLs.
 */
export function sumCosts(costs: readonly Cost[]): CostSum {
  let priced = 0;
  let unpricedCount = 0;
  for (const c of costs) {
    if (c === null) unpricedCount += 1;
    else priced += c;
  }
  return { priced, unpricedCount, total: unpricedCount > 0 ? null : priced };
}

/** Four decimals: a single cheap call can be worth well under a cent. */
export function formatCost(cost: Cost): string {
  if (cost === null) return "n/a";
  return `$${cost.toFixed(4)}`;
}

/** Render a sum honestly, flagging that it is a lower bound when it is one. */
export function formatCostSum(sum: CostSum): string {
  if (sum.unpricedCount === 0) return formatCost(sum.priced);
  return `≥ $${sum.priced.toFixed(4)} (+${sum.unpricedCount} n/a)`;
}
