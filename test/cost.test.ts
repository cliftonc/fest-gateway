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

test("rate lookup is exact, strips the 1m tag, and never guesses", () => {
  // Dated snapshots are carried explicitly by the catalog, so they resolve
  // without prefix matching — which is the point: a prefix rule would let
  // `claude-opus-4-1-20260101` fall back to a bare `claude-opus` at a
  // completely different rate.
  assert.equal(lookupRate("claude-opus-4-1-20250805")?.label, "claude-opus-4-1-20250805");
  assert.equal(lookupRate("claude-sonnet-4-5")?.label, "claude-sonnet-4-5");
  // Claude Code appends [1m] client-side for context sizing.
  assert.equal(lookupRate("claude-opus-5[1m]")?.label, "claude-opus-5");
  assert.equal(lookupRate("some-unknown-model"), null);
  assert.equal(lookupRate(null), null);
});

test("Claude rates come from the catalog, not a stale hand-written table", () => {
  // The hand-maintained table this replaced priced Opus 5 at $15/$75 per
  // million — 3x the real rate. Pinning the published numbers here means the
  // next drift of that size fails a test instead of inflating a dashboard.
  const r = lookupRate("claude-opus-5")!;
  assert.equal(r.base.inputPerMillion, 5);
  assert.equal(r.base.outputPerMillion, 25);
  assert.equal(r.provider, "anthropic");
});

test("a Fireworks model routed by routes.json resolves against its provider", () => {
  // The exact id shape a substitute route sends upstream. Without the provider
  // hint this is unpriceable, which is what the whole substitute path used to
  // be: every Fireworks request landing in the "n/a" bucket.
  const id = "accounts/fireworks/models/deepseek-v4-pro";
  assert.equal(lookupRate(id), null, "ambiguous without a provider");

  const r = lookupRate(id, "fireworks_ai");
  assert.ok(r, "resolves once the adapter's provider is supplied");
  assert.equal(r.provider, "fireworks_ai");
  assert.ok(r.base.inputPerMillion > 0);
});

test("token buckets are priced disjointly, not folded together", () => {
  const r = lookupRate("claude-opus-5")!;
  // Cache reads are ~10% of input; folding them into input would be a ~10x error.
  assert.equal(r.base.cacheReadPerMillion, r.base.inputPerMillion * 0.1);
  assert.equal(r.base.cacheWrite5mPerMillion, r.base.inputPerMillion * 1.25);
  assert.equal(r.base.cacheWrite1hPerMillion, r.base.inputPerMillion * 2);

  const priced = priceUsage(
    "claude-opus-5",
    usage({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 }),
    false,
  );
  // 5 (input) + 0.5 (cache read) + 25 (output)
  assert.equal(priced.cost, 30.5);
  assert.equal(priced.basis, "list");
});

test("a subscription request has no dollar cost, and that is not zero", () => {
  const priced = priceUsage("claude-opus-5", usage({ inputTokens: 1_000_000 }), true);
  // The developer's own plan absorbed it: there is no org spend to report, and
  // this must never become 0 or be summed into a spend total.
  assert.equal(priced.cost, null);
  assert.equal(priced.basis, "subscription");
});

test("a subscription request still records what it WOULD have cost", () => {
  const u = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  const sub = priceUsage("claude-opus-5", u, true);
  const api = priceUsage("claude-opus-5", u, false);

  // Same work, same list value — the only difference is who was invoiced.
  assert.equal(sub.notionalCost, 30);
  assert.equal(api.notionalCost, 30);
  assert.equal(api.cost, 30);
  // The load-bearing half: value is populated, spend is not.
  assert.equal(sub.cost, null);
});

test("an unknown model is unpriced on BOTH figures, never estimated", () => {
  const priced = priceUsage("mystery-model-9", usage({ inputTokens: 1000 }), false);
  assert.equal(priced.cost, null);
  assert.equal(priced.basis, "none");
  // We do not know what it charges, so we do not know what it was worth either.
  assert.equal(priced.notionalCost, null);

  // Unknown on the subscription path keeps the subscription basis: the reason
  // there is no spend is still the developer's plan, not the missing rate.
  const sub = priceUsage("mystery-model-9", usage({ inputTokens: 1000 }), true);
  assert.equal(sub.basis, "subscription");
  assert.equal(sub.notionalCost, null);
});

test("a long-context call bills the whole request at the higher tier", () => {
  // Sonnet 4.5 doubles above 200k. The tier applies to the ENTIRE call, not
  // just the tokens past the line — which is where 1M-context Claude Code
  // sessions were previously understated by half.
  const short = priceUsage("claude-sonnet-4-5", usage({ inputTokens: 100_000 }), false);
  const long = priceUsage("claude-sonnet-4-5", usage({ inputTokens: 300_000 }), false);

  assert.equal(short.cost, 0.3);
  // 300k at the above-200k rate ($6/M), not 200k at $3 plus 100k at $6.
  assert.equal(long.cost, 1.8);
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
