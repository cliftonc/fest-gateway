import { test } from "node:test";
import assert from "node:assert/strict";
import { addCost, sumCosts, formatCost, formatCostSum } from "../server/usage/cost.ts";
import { lookupRate, priceUsage, cacheHitRatio } from "../server/usage/pricing.ts";
import { EMPTY_USAGE, contextTokens } from "../shared/types.ts";
import type { UsagePayload } from "../shared/types.ts";

const usage = (over: Partial<UsagePayload> = {}): UsagePayload => ({ ...EMPTY_USAGE, ...over });

test("null cost propagates through addition", () => {
  assert.equal(addCost(1, 2), 3);
  // An unpriceable component must poison the total rather than vanish.
  assert.equal(addCost(1, null), null);
  assert.equal(addCost(null, null), null);
});

test("sumCosts keeps the unpriced count so a total is never silently short", () => {
  const s = sumCosts([1, 2, null, 4]);
  assert.equal(s.priced, 7);
  assert.equal(s.unpricedCount, 1);
  // total is null specifically so a caller cannot use it by accident.
  assert.equal(s.total, null);
  assert.equal(formatCostSum(s), "≥ $7.0000 (+1 n/a)");

  const clean = sumCosts([1, 2]);
  assert.equal(clean.total, 3);
  assert.equal(formatCostSum(clean), "$3.0000");
});

test("unavailable cost renders n/a, never $0", () => {
  assert.equal(formatCost(null), "n/a");
  assert.notEqual(formatCost(null), "$0.0000");
  // Four decimals: a cheap call can be worth far under a cent.
  assert.equal(formatCost(0.00012), "$0.0001");
});

test("rate lookup prefers the longest matching prefix and strips the 1m tag", () => {
  assert.equal(lookupRate("claude-opus-4-1-20260101")?.label, "Claude Opus 4.1");
  assert.equal(lookupRate("claude-sonnet-4-5")?.label, "Claude Sonnet 4.5");
  // Claude Code appends [1m] client-side for context sizing.
  assert.equal(lookupRate("claude-opus-5[1m]")?.label, "Claude Opus 5");
  assert.equal(lookupRate("some-unknown-model"), null);
  assert.equal(lookupRate(null), null);
});

test("token buckets are priced disjointly, not folded together", () => {
  const r = lookupRate("claude-opus-5")!;
  // Cache reads are ~10% of input; folding them into input would be a ~10x error.
  assert.equal(r.cacheReadPerMillion, r.inputPerMillion * 0.1);
  assert.equal(r.cacheWrite5mPerMillion, r.inputPerMillion * 1.25);
  assert.equal(r.cacheWrite1hPerMillion, r.inputPerMillion * 2);

  const priced = priceUsage(
    "claude-opus-5",
    usage({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 }),
    false,
  );
  // 15 (input) + 1.5 (cache read) + 75 (output)
  assert.equal(priced.cost, 91.5);
  assert.equal(priced.basis, "list");
});

test("a subscription request has no dollar cost, and that is not zero", () => {
  const priced = priceUsage("claude-opus-5", usage({ inputTokens: 1_000_000 }), true);
  // The developer's own plan absorbed it: there is no org spend to report.
  assert.equal(priced.cost, null);
  assert.equal(priced.basis, "subscription");
  // Deliberately no notional list price: a number in a cost column gets summed
  // eventually, however it is labelled.
  assert.equal(priced.rateLabel, null);
});

test("an unknown model is unpriced, never estimated", () => {
  const priced = priceUsage("mystery-model-9", usage({ inputTokens: 1000 }), false);
  assert.equal(priced.cost, null);
  assert.equal(priced.basis, "none");
});

test("web searches are billed per thousand on top of tokens", () => {
  const priced = priceUsage("claude-opus-5", usage({ webSearches: 1000 }), false);
  assert.equal(priced.cost, 10);
});

test("context size is the sum of all four disjoint buckets", () => {
  const u = usage({
    inputTokens: 100,
    cacheReadTokens: 900,
    cacheWrite5mTokens: 50,
    cacheWrite1hTokens: 10,
    outputTokens: 7,
  });
  // Output does not occupy the input context window.
  assert.equal(contextTokens(u), 1060);
  assert.equal(cacheHitRatio(u), 900 / 1060);
  assert.equal(cacheHitRatio(EMPTY_USAGE), null);
});
