# Frontend stack (Phase 3)

Decided 2026-09-21: **Vite + React**, with **TanStack Query** for server state
and **TanStack Charts** for the graph/visualisation side. Possibly
**TanStack Table** for the request feed.

## Why TanStack Query fits this dashboard

- The live feed is a filtered list. Query's cache keys map directly onto the
  filter tuple `(range, userId, servedModel, credentialOrigin, errorsOnly)`, so
  flipping a filter is a cache hit rather than a refetch.
- `staleTime` plus background refetch gives "always fresh" without hand-rolling
  an interval per screen.
- The SSE live feed integrates via `queryClient.setQueryData` on each event, so
  the streaming feed and the paged history share one cache instead of drifting
  apart.
- `useInfiniteQuery` + `getNextPageParam` consumes the read layer's keyset
  `nextCursor` directly. That is *why* the query layer returns a cursor instead
  of an offset.

## Charts — one thing to check first

TanStack Charts is considerably newer than the rest of the family. Before
committing, confirm it covers the three shapes this dashboard actually needs:

1. **Hourly time series** (tokens and requests over a range) — from
   `usageSeries`.
2. **Stacked bars** for credential posture — subscription vs server-held key,
   the compliance view.
3. **Latency histogram** from the six fixed buckets (`lat_b0..lat_b5`).

If any is missing, the fallback is inline SVG for that one chart rather than
swapping libraries. The data is already pre-aggregated server-side — the buckets
are stored bucketed and the series comes back per hour — so there is very little
for a chart library to do beyond drawing.

## Rules the UI must not break

- **Never add a dollar figure to subscription usage.** `costUsd` is `null` with
  `costBasis: "subscription"` on purpose: the developer's own plan absorbed it,
  so there is no org spend. Render subscription and metered totals side by side,
  never summed.
- **Render `null` cost as `n/a`, never `$0.00`.** An unpriceable call is not a
  free call. Where `unpricedRequests > 0`, the total is a lower bound — show it
  as `≥ $12.3456 (+3 n/a)`.
- **For subscription developers, lead with quota rather than cost**: 5h/7d
  utilisation, the binding window from `representative-claim`, and
  `overageStatus`. That is the number a team lead can act on.
- **Show unattributed usage rather than hiding it.** Requests with a null
  `user_id` mean somebody is not using an identity token, which is a thing an
  admin needs to see.
- **Percentiles from the bucket histogram are interpolated, not exact.** Label
  them accordingly; percentiles genuinely do not merge across rollup rows, which
  is why buckets exist at all.
- **Escape everything.** Model ids and token names are user-supplied.
