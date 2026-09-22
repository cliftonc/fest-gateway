-- Notional cost: what usage WOULD have cost at published API rates.
--
-- The motivating gap: subscription requests are the bulk of Fest's traffic and
-- carry no dollar figure at all, because `cost_usd` is org spend and a
-- developer's own plan absorbed them. That is correct for an invoice and
-- useless for a team lead asking what their Max seats deliver.
--
-- So this is a SECOND, PARALLEL figure, never a widening of the first:
--
--   * `cost_usd` remains org spend. Subscription rows stay NULL. Every existing
--     aggregate, guard and UI label is unchanged.
--   * `notional_cost_usd` is VALUE, populated on every path including
--     subscription. It is never added to `cost_usd` anywhere — the two live in
--     separate columns, separate SQL aggregates and separate dashboard stats
--     precisely so that summing them is never the easy thing to do.
--
-- Existing rows keep NULL / 0. They are genuinely unknown: back-filling them at
-- today's rates would invent a history that never happened, and rates drift.

ALTER TABLE requests ADD COLUMN notional_cost_usd REAL;

ALTER TABLE usage_hourly ADD COLUMN notional_cost_usd REAL NOT NULL DEFAULT 0;

-- The same honesty device as `unpriced_requests`, and needed for the same
-- reason: SUM() skips NULLs, so without a count the notional total looks
-- complete while silently omitting every model with no published rate.
-- Non-zero means `notional_cost_usd` is a lower bound.
ALTER TABLE usage_hourly ADD COLUMN notional_unpriced_requests INTEGER NOT NULL DEFAULT 0;
