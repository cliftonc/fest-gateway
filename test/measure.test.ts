/**
 * What the Live screen's three sets of books are allowed to say.
 *
 * The danger here is not arithmetic, it is a plausible-looking number. Every
 * assertion in this file is really asking one of two questions: does absorbed
 * work ever get shown as free, and does a total that omits rows it could not
 * price ever get shown as exact? Both failures render beautifully.
 *
 * These functions are the presentation end of the rules `server/store/write.ts`
 * enforces on the way in, and the first thing in `test/` to cover `web/src`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareByMeasure,
  emptyTally,
  formatAmount,
  formatTally,
  isLowerBound,
  magnitude,
  tallyAdd,
  tallyTokens,
  zeroReason,
  type MeasurableEvent,
  type MeasureTally,
} from "../web/src/lib/measure.ts";

const event = (over: Partial<MeasurableEvent> = {}): MeasurableEvent => ({
  subscription: false,
  costUsd: 0.01,
  notionalCostUsd: 0.01,
  context: 1000,
  cacheWrite: 100,
  output: 50,
  ...over,
});

const tallyOf = (...events: readonly MeasurableEvent[]): MeasureTally => {
  const t = emptyTally();
  for (const e of events) tallyAdd(t, e);
  return t;
};

test("subscription work is absorbed, not billed at zero", () => {
  const t = tallyOf(event({ subscription: true, costUsd: null, notionalCostUsd: 0.42 }));

  assert.equal(t.billedUsd, 0);
  assert.equal(t.subscriptionRequests, 1);
  // The row could not be priced, but that is not a pricing FAILURE — it is not
  // supposed to have a price. Counting it as unpriced would put a `≥` on a
  // figure that is exactly right.
  assert.equal(t.billedUnpriced, 0);
  assert.equal(isLowerBound(t, "billed"), false);
  assert.equal(formatTally(t, "billed"), "$0.0000");

  // Value runs on its own books and takes the row in full.
  assert.equal(t.valueUsd, 0.42);
  assert.equal(formatTally(t, "value"), "~$0.4200");
});

test("an unpriceable request makes the billed total a lower bound", () => {
  const t = tallyOf(event({ costUsd: 0.25 }), event({ costUsd: null }));

  assert.equal(t.billedUsd, 0.25);
  assert.equal(t.billedUnpriced, 1);
  assert.equal(isLowerBound(t, "billed"), true);
  assert.equal(formatTally(t, "billed"), "≥ $0.2500");
});

test("an unpriceable request makes the value total a lower bound too", () => {
  const t = tallyOf(event({ notionalCostUsd: 2 }), event({ notionalCostUsd: null }));

  assert.equal(isLowerBound(t, "value"), true);
  // The `~` sits inside the `≥`, matching notionalTotal.
  assert.equal(formatTally(t, "value"), "≥ ~$2.00");
});

test("a fraction of a cent is never rendered as $0.00", () => {
  // The failure this guards is the one RollupBoard used to invite: a figure
  // rounded to the dollar reads as "free" when it means "small".
  assert.equal(formatAmount(0.0043, "value"), "~$0.0043");
  assert.equal(formatAmount(0.0043, "billed"), "$0.0043");
  assert.equal(formatAmount(1204.5, "billed"), "$1204.50");
});

test("tokens are never a lower bound — they are counted, not priced", () => {
  const t = tallyOf(event({ costUsd: null, notionalCostUsd: null }));

  assert.equal(isLowerBound(t, "tokens"), false);
  assert.equal(tallyTokens(t), 1150);
  assert.equal(formatTally(t, "tokens"), "1.1k");
});

test("a subscription-only window explains its zero rather than looking idle", () => {
  const t = tallyOf(
    event({ subscription: true, costUsd: null, notionalCostUsd: 0.5 }),
    event({ subscription: true, costUsd: null, notionalCostUsd: 0.5 }),
  );

  assert.equal(magnitude(t, "billed"), 0);
  assert.match(zeroReason(t, "billed", 2) ?? "", /developer subscriptions/);

  // Value is not zero here, so there is nothing to explain.
  assert.equal(zeroReason(t, "value", 2), null);
  // Nor in tokens, ever: a zero-token window is a quiet gateway, not an
  // accounting subtlety.
  assert.equal(zeroReason(t, "tokens", 2), null);
  // And an empty window is already covered by the board's own empty state.
  assert.equal(zeroReason(emptyTally(), "billed", 0), null);
});

test("ranking is a total order even when every magnitude is zero", () => {
  /*
   * The bug this exists to stop: on a subscription-only gateway in billed mode
   * every value is 0, so a magnitude-only comparator ties on every pair. Sort
   * is stable, so the order would fall back to insertion order — which is
   * first-seen-event order, and reshuffles each time the window rolls an event
   * off the front. RollupBoard animates rank changes, so the board would churn
   * while nothing at all was happening.
   */
  const row = (key: string, context: number) => ({
    key,
    requests: 1,
    tally: tallyOf(event({ subscription: true, costUsd: null, notionalCostUsd: null, context })),
  });

  const a = row("alpha", 300);
  const b = row("bravo", 200);
  const c = row("charlie", 100);

  const order = (rows: ReturnType<typeof row>[]): string[] =>
    [...rows].sort(compareByMeasure("billed")).map((r) => r.key);

  assert.deepEqual(order([a, b, c]), ["alpha", "bravo", "charlie"]);
  // Independent of insertion order — that is the whole point.
  assert.deepEqual(order([c, a, b]), ["alpha", "bravo", "charlie"]);
  assert.deepEqual(order([b, c, a]), ["alpha", "bravo", "charlie"]);
});

test("the measure changes the ranking — which is what the switch is for", () => {
  // Chatty and cheap against quiet and expensive.
  const chatty = {
    key: "chatty",
    requests: 10,
    tally: tallyOf(event({ context: 100_000, costUsd: 0.01, notionalCostUsd: 0.01 })),
  };
  const pricey = {
    key: "pricey",
    requests: 1,
    tally: tallyOf(event({ context: 100, costUsd: 5, notionalCostUsd: 5 })),
  };

  assert.deepEqual(
    [chatty, pricey].sort(compareByMeasure("tokens")).map((r) => r.key),
    ["chatty", "pricey"],
  );
  assert.deepEqual(
    [chatty, pricey].sort(compareByMeasure("billed")).map((r) => r.key),
    ["pricey", "chatty"],
  );
});
