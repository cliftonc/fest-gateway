# Pricing: where the dollar figures come from

Fest shows two dollar figures for the same traffic. They are different things,
and most of this document exists to keep them different.

## Spend vs. value

| | `costUsd` / "Org spend" | `notionalCostUsd` / "At list rates" |
|---|---|---|
| Means | what the organisation will be invoiced | what the work would cost at published API rates |
| Subscription request | `null` — the developer's own plan absorbed it | populated |
| Substituted request (server key) | the real cost | the same figure |
| Unknown model | `null` | `null` |
| Safe to sum into a budget | yes | **no** |

A team where every developer runs on their own Max seat correctly shows **$0
spend and a large value figure**. Both numbers are true, and neither one alone
answers "is this gateway worth it". That is the whole reason there are two.

The separation is structural, not a convention: separate columns in `requests`
and `usage_hourly`, separate SQL aggregates in `store/queries.ts`, separate
fields on `UsageTotalsWire`, and separate formatters (`costTotal` vs
`notionalTotal`) in `web/src/lib/format.ts`. There is deliberately no helper
anywhere that adds them.

`null` never means zero on either figure. An unpriceable call is not a free
call, and a subscription call is not a $0 call — see `server/usage/cost.ts` for
the null-propagating algebra, and the `≥ $12.3456 (+3 n/a)` rendering that keeps
a partial total honest about being a lower bound.

## Where rates come from

[litellm's `model_prices_and_context_window.json`][litellm] — ~3200 chat models
across every provider it tracks, including all the Claude ids and ~330 Fireworks
ones.

This replaced a hand-maintained table of 13 Claude entries. It was not replaced
for coverage alone: by the time it went, it priced Claude Opus 5 at $15/$75 per
million against a real rate of $5/$25. Everything it priced was 3x high. Rates
drift, and a table nobody is responsible for updating drifts silently.

[litellm]: https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json

### The snapshot, and why it is vendored

`server/usage/prices/snapshot.json.gz` (~66KB) is committed. It is litellm's
file filtered to `mode: "chat"` and to the five token buckets Fest meters, then
normalised to USD per million and gzipped.

It is committed because **a gateway must not depend on an external price service
to serve a request**. A fresh clone, a CI run, a container in an airgapped
network and a GitHub outage all price correctly, with no network and no
first-boot special case.

`loadPrices()` reads it synchronously at boot, before the listener is up.

### The refresh

`startPriceRefresh()` fetches litellm on an unref'd timer — once shortly after
boot, then every 24 hours — and caches the result next to the database as
`prices.json`. It exists because a *new model* ships the week it ships, and an
unpriced model is a row the dashboard has to report as "n/a".

Three properties it will not give up:

- **Boot never waits on it.** The fetch is deferred, not awaited.
- **Failure changes nothing.** A non-200, a timeout, a malformed body or a
  response that parses but prices nothing all leave the previous table and the
  previous cache exactly as they were, and log one warn line.
- **No request waits on it.** Refreshing swaps a whole catalog in one
  assignment, off the hot path.

On boot the cache wins only if its `fetchedAt` is **newer than the snapshot's**.
That comparison is on the timestamp rather than file mtime for a specific
reason: upgrading Fest ships a newer snapshot, and a stale `prices.json` left in
a mounted data volume would otherwise shadow it forever.

| Variable | Default | |
|---|---|---|
| `FEST_PRICING_REFRESH` | on | Set `0`/`false`/`off` to never dial out. The snapshot is then the only source. |
| `FEST_PRICING_URL` | litellm on GitHub | Point at an internal mirror. |

### Updating the snapshot by hand

```bash
npm run prices:sync
```

Fetches, normalises, writes the snapshot and prints a diff — models added,
models gone, and **every rate that changed, in full**. Read that list before
committing: a rate change retroactively changes every dollar figure Fest
displays, and a 66KB binary blob in a pull request is otherwise unreviewable.

## How a call is priced

`priceUsage(model, usage, postureIsSubscription, provider?)` in
`server/usage/pricing.ts`.

**Lookup is exact.** In order: the raw id, then `provider/id`, then
`provider/<leaf>`; each tried again with Claude Code's client-side `[1m]`
context tag stripped. Anything else is `null`.

There is deliberately no prefix matching. The old 13-entry table needed it to
resolve dated snapshots; litellm carries every dated id explicitly alongside its
alias, so a prefix rule would now be *guessing where an exact answer exists* —
and guessing badly, since `claude-opus-4-5-20251101` would happily match a bare
`claude-opus` entry at an unrelated rate.

**The `provider` argument matters on the substitute path.** A route sends
`accounts/fireworks/models/deepseek-v4-pro`, which is ambiguous alone; litellm
files it under `fireworks_ai/...`. The mapping from Fest's adapter id to
litellm's provider key is `ADAPTER_PRICE_PROVIDERS` in
`server/adapters/registry.ts`. **A new adapter must add a line there**, or its
traffic prices as unknown — which is the correct failure, since an "n/a" on a
dashboard is a question someone asks and a wrong dollar figure is one nobody
does.

**The token buckets are disjoint and priced separately.** Cache reads are ~10%
of input, a 5-minute cache write ~125%, a 1-hour write ~200%. Folding cache
reads into input is an order-of-magnitude error on a cache-heavy agent workload,
which Claude Code is.

**Long-context tiers apply to the whole call.** Sonnet 4.5 doubles above 200k
tokens; thresholds vary by model (128k, 200k, 256k, 272k and 512k all appear in
the catalog, so they are parsed from the key name rather than hardcoded). Once
context crosses the line the *entire* request prices at the higher rate, which
is how the vendors publish it — and is where Claude Code's 1M-context sessions
were previously understated by half.

**A provider with no published cache rate bills cache as ordinary input.** Not
zero, which would claim cache reads are free; and not Anthropic's ×0.1/×1.25/×2
multipliers, which are Anthropic's policy and would invent a discount another
vendor does not offer.

## Adding a provider

1. Write the adapter (`server/adapters/`).
2. Add its litellm provider key to `ADAPTER_PRICE_PROVIDERS`.
3. That's it — the catalog already has the rates if litellm tracks the provider.

`test/pricing-table.test.ts` asserts every adapter maps to a provider that
exists in the catalog, and that every model in `routes.example.json` prices
through its adapter. Both fail loudly rather than degrading to "n/a".
