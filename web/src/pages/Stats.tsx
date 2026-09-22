/**
 * Stats: traffic, who paid for it, cost, cache behaviour, latency, rate-limit
 * headroom, and the health of the metering pipeline itself.
 *
 * "Who paid" lives here rather than on Routing because it is an observation
 * about traffic that has already happened, which is what every other panel on
 * this screen is; Routing is config, and answers what Fest *will* do.
 * `inbound_subscription` means the developer's own Max/Team plan absorbed the
 * request and the org spent nothing; `fallback_server` means Fest substituted a
 * key the server holds, which is real org spend and must never happen quietly.
 *
 * Quota sits alongside it because on a subscription the marginal cost of a
 * request is zero and the scarce resource is the rate-limit window. The
 * actionable number there is 5h/7d utilisation and which window is currently
 * binding — which Anthropic hands us on every response, exactly, with no price
 * table involved.
 *
 * The metering pipeline panel is not padding either. The sink drops the oldest
 * record when its queue is full, by design — the proxy degrades its metrics
 * before it degrades a developer's stream. A dashboard that hid the drop
 * counter would silently under-report and look perfectly healthy doing it, so
 * the counter is on the page rather than in a debug endpoint.
 */

import { useQuery } from "@tanstack/react-query";
import { api, type Range } from "../lib/api.ts";
import { isExactRange } from "../lib/range.ts";
import {
  Card,
  Meter,
  Muted,
  Pill,
  QueryState,
  Stat,
  StatRow,
  Table,
  TableCell,
  TableRow,
  TONE_TEXT,
  numCol,
} from "../components/ui.tsx";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";
import {
  LatencyChart,
  Legend,
  ORIGIN_ORDER,
  PostureChart,
  TrafficChart,
  useOriginColors,
} from "../components/charts.tsx";
import { useStatusColors } from "../lib/colors.ts";
import {
  ORIGIN_LABELS,
  contextTokens,
  costTotal,
  ms,
  notionalTotal,
  num,
  originLabel,
  personLabel,
  ratio,
  relative,
  tokens,
  when,
} from "../lib/format.ts";

/** Above this, a developer is close enough to the wall to warn about. */
const WARN_AT = 0.8;
const BAD_AT = 0.95;

const utilTone = (v: number | null): "ok" | "warn" | "bad" | "muted" =>
  v === null ? "muted" : v >= BAD_AT ? "bad" : v >= WARN_AT ? "warn" : "ok";

/** `Meter` has no "unknown" fill, so an unknown utilisation draws as neutral. */
const meterTone = (v: number | null): "ok" | "warn" | "bad" | "info" =>
  v === null ? "info" : v >= BAD_AT ? "bad" : v >= WARN_AT ? "warn" : "ok";

export function StatsPage({ range }: { range: Range }): React.JSX.Element {
  const c = useStatusColors();
  const originColors = useOriginColors();
  // Same order and meaning as TrafficChart's stack, read from the same tokens:
  // a legend that disagrees with the chart it labels is worse than no legend.
  const bucketLegend = [
    { label: "Input", color: c.info },
    { label: "Cache read", color: c.ok },
    { label: "Cache write 5m", color: c.sub },
    { label: "Cache write 1h", color: c.warn },
  ];

  const overview = useQuery({
    queryKey: ["overview", range.fromMs, range.toMs],
    queryFn: () => api.overview(range),
  });

  const quota = useQuery({ queryKey: ["quota"], queryFn: api.quota });

  const d = overview.data;
  const totals = d?.totals;
  const sink = d?.sink;
  const exact = isExactRange(range);

  const origins = d?.byCredentialOrigin ?? [];
  const totalRequests = origins.reduce((a, r) => a + r.requests, 0);
  const share = (id: string): number =>
    totalRequests === 0
      ? 0
      : (origins.find((o) => o.credentialOrigin === id)?.requests ?? 0) / totalRequests;
  const serverKeyRequests =
    origins.find((o) => o.credentialOrigin === "fallback_server")?.requests ?? 0;

  return (
    <>
      {serverKeyRequests > 0 && (
        <Alert variant="warning" className="mb-4">
          <AlertDescription>
            {num(serverKeyRequests)} request{serverKeyRequests === 1 ? "" : "s"} in this range ran
            on a <strong>server-held key</strong> rather than a developer's own subscription. That
            is org spend, and it is billed to whoever owns that key — check the Models screen for
            which model triggered the substitution, and Routing for the rule that did it.
          </AlertDescription>
        </Alert>
      )}

      {sink !== undefined && sink.dropped > 0 && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>
            The metering queue dropped {num(sink.dropped)} record
            {sink.dropped === 1 ? "" : "s"} under load. Every number on this dashboard is therefore
            a lower bound. Requests themselves were unaffected — the proxy sheds metrics before it
            sheds traffic.
          </AlertDescription>
        </Alert>
      )}

      <Card title="This range">
        <QueryState isPending={overview.isPending} error={overview.error} isEmpty={totals?.requests === 0}>
          <StatRow>
            <Stat label="Requests" value={num(totals?.requests ?? 0)} />
            <Stat
              label="Errors"
              value={num(totals?.errors ?? 0)}
              tone={(totals?.errors ?? 0) > 0 ? "bad" : "muted"}
              note={totals === undefined || totals.requests === 0 ? undefined : ratio(totals.errors / totals.requests)}
            />
            <Stat
              label="Context tokens"
              value={totals === undefined ? "—" : tokens(contextTokens(totals.usage))}
              note="input + cache read + cache write"
            />
            <Stat
              label="Output tokens"
              value={totals === undefined ? "—" : tokens(totals.usage.outputTokens)}
            />
            <Stat
              label="Cache hit ratio"
              value={ratio(totals?.cacheHitRatio ?? null)}
              note="cache reads / context"
              tone={(totals?.cacheHitRatio ?? 0) > 0.5 ? "ok" : "muted"}
            />
            <Stat
              label="Org spend"
              value={totals === undefined ? "—" : costTotal(totals)}
              note={`${num(totals?.subscriptionRequests ?? 0)} subscription requests excluded`}
            />
            <Stat
              label="Value at list rates"
              value={totals === undefined ? "—" : notionalTotal(totals)}
              tone="sub"
              note="all usage, incl. subscription"
            />
          </StatRow>
          {totals !== undefined && totals.requests > 0 && (
            <p className="mt-3">
              <Muted>
                <strong>{costTotal(totals)} billed</strong> to the org ·{" "}
                <strong>{notionalTotal(totals)} of work</strong> at published API rates.
                The gap is what developers' own subscriptions absorbed — real usage the org was
                never invoiced for. The two are deliberately not added together: one is an
                invoice, the other is what the work was worth.
              </Muted>
            </p>
          )}
        </QueryState>
      </Card>

      <Card
        title="Who paid for this traffic"
        subtitle="Subscription usage and metered spend are shown side by side and never added: a request a developer's own plan absorbed cost the org nothing, which is not the same as costing zero."
      >
        <QueryState
          isPending={overview.isPending}
          error={overview.error}
          isEmpty={totalRequests === 0}
        >
          <StatRow>
            <Stat
              label="On own subscription"
              value={ratio(share("inbound_subscription"))}
              note={`${num(origins.find((o) => o.credentialOrigin === "inbound_subscription")?.requests ?? 0)} requests`}
              tone="ok"
            />
            <Stat
              label="On a server-held key"
              value={ratio(share("fallback_server"))}
              note={`${num(serverKeyRequests)} requests`}
              tone={serverKeyRequests > 0 ? "warn" : "muted"}
            />
            <Stat
              label="Absorbed by subscriptions"
              value={num(totals?.subscriptionRequests ?? 0)}
              note="real usage, no org spend"
              tone="muted"
            />
          </StatRow>

          <PostureChart rows={origins} />
          <Legend
            items={ORIGIN_ORDER.filter((o) =>
              origins.some((r) => r.credentialOrigin === o && r.requests > 0),
            ).map((o) => ({ label: ORIGIN_LABELS[o] ?? o, color: originColors[o] ?? "" }))}
          />

          <Table
            head={[
              "Credential origin",
              numCol("Requests"),
              numCol("People"),
              numCol("Errors"),
              numCol("Tokens"),
              numCol("Cost"),
              numCol("At list rates"),
            ]}
          >
            {origins.map((row) => (
              <TableRow key={row.credentialOrigin}>
                <TableCell>
                  <Pill
                    tone={
                      row.credentialOrigin === "inbound_subscription"
                        ? "ok"
                        : row.credentialOrigin === "fallback_server"
                          ? "warn"
                          : "muted"
                    }
                  >
                    {originLabel(row.credentialOrigin)}
                  </Pill>
                </TableCell>
                <TableCell className="num">{num(row.requests)}</TableCell>
                <TableCell className="num">{num(row.distinctUsers)}</TableCell>
                <TableCell className="num">
                  {row.errors === 0 ? <Muted>0</Muted> : row.errors}
                </TableCell>
                <TableCell className="num">
                  {tokens(
                    row.usage.inputTokens +
                      row.usage.cacheReadTokens +
                      row.usage.cacheWrite5mTokens +
                      row.usage.cacheWrite1hTokens +
                      row.usage.outputTokens,
                  )}
                </TableCell>
                <TableCell className="num">
                  {row.subscriptionRequests === row.requests ? (
                    <Muted title="A subscription absorbed every request in this row, so no dollar figure applies.">
                      subscription
                    </Muted>
                  ) : (
                    costTotal(row)
                  )}
                </TableCell>
                {/*
                  Priced on every row, which is what makes this table a
                  comparison: a substituted row shows what the org actually paid
                  next to what the same tokens were worth, and a subscription row
                  shows value against a cost column that reads "subscription".
                */}
                <TableCell className="num text-status-sub">{notionalTotal(row)}</TableCell>
              </TableRow>
            ))}
          </Table>
        </QueryState>
      </Card>

      <Card
        title="Tokens per hour"
        subtitle="The four buckets are disjoint: input excludes cache reads and writes, so the stack height is the context consumed, not a double count."
      >
        <QueryState isPending={overview.isPending} error={overview.error} isEmpty={(d?.series.length ?? 0) === 0}>
          {d !== undefined && (
            <>
              <TrafficChart series={d.series} fromMs={range.fromMs} toMs={range.toMs} />
              <Legend items={bucketLegend} />
            </>
          )}
        </QueryState>
      </Card>

      <Card
        title="Latency"
        subtitle={
          exact
            ? "Exact: this range is short enough that the server reads raw request rows."
            : "Percentiles are interpolated from six fixed buckets — a p95 of 24s means “somewhere in 10–30s”. Narrow the range to under two hours for exact figures."
        }
      >
        <QueryState
          isPending={overview.isPending}
          error={overview.error}
          isEmpty={(d?.latency.count ?? 0) === 0}
        >
          <StatRow>
            <Stat label="Median" value={ms(d?.latency.p50Ms ?? null)} note={exact ? "exact" : "approx."} />
            <Stat label="p95" value={ms(d?.latency.p95Ms ?? null)} note={exact ? "exact" : "approx."} />
            <Stat label="Mean TTFB" value={ms(d?.latency.avgTtfbMs ?? null)} note="time to first byte" />
            <Stat label="Slowest" value={ms(d?.latency.maxDurationMs ?? null)} />
          </StatRow>
          {d !== undefined && <LatencyChart buckets={d.latency.buckets} />}
        </QueryState>
      </Card>

      <Card
        title="Metering pipeline"
        subtitle="Usage records are queued and written in batches off the request path. A hard crash loses at most one flush interval — right for telemetry, wrong for a chargeback ledger."
      >
        <QueryState isPending={overview.isPending} error={overview.error}>
          <StatRow>
            <Stat label="Written" value={num(sink?.written ?? 0)} />
            <Stat label="Queued" value={num(sink?.queued ?? 0)} tone="muted" />
            <Stat
              label="Dropped"
              value={num(sink?.dropped ?? 0)}
              tone={(sink?.dropped ?? 0) > 0 ? "bad" : "muted"}
              note="queue overflow"
            />
            <Stat
              label="Write errors"
              value={num(sink?.writeErrors ?? 0)}
              tone={(sink?.writeErrors ?? 0) > 0 ? "bad" : "muted"}
            />
            <Stat
              label="Last flush"
              value={sink?.lastFlushMs === null || sink === undefined ? "—" : ms(sink.lastFlushMs)}
            />
          </StatRow>
          {sink !== undefined && sink.trailErrors > 0 && (
            <p>
              <Muted>
                {num(sink.trailErrors)} JSONL trail write{sink.trailErrors === 1 ? "" : "s"} failed.
                The trail is a convenience copy; the database is the record, so this is not data
                loss.
              </Muted>
            </p>
          )}
        </QueryState>
      </Card>

      <Card
        title="Rate-limit headroom, per developer"
        subtitle="The latest quota Anthropic reported for each person. This is the scarce resource on a subscription — not money. It reads raw request rows, so it empties as retention removes them."
      >
        <QueryState
          isPending={quota.isPending}
          error={quota.error}
          isEmpty={(quota.data?.rows.length ?? 0) === 0}
          emptyText="No quota headers observed yet. They arrive on every subscription response, so this fills in as soon as someone runs a turn."
        >
          <Table head={["Developer", "5-hour window", "7-day window", "Binding", "Overage", "Observed"]}>
            {(quota.data?.rows ?? []).map((row) => (
              <TableRow key={row.userId ?? "unattributed"}>
                <TableCell>{personLabel(row.userId, row.email)}</TableCell>
                <TableCell>
                  <span className={TONE_TEXT[utilTone(row.fiveHourUtilization)]}>
                    {ratio(row.fiveHourUtilization)}
                  </span>
                  <Meter
                    value={row.fiveHourUtilization}
                    tone={meterTone(row.fiveHourUtilization)}
                    label="5-hour utilisation"
                  />
                  <Muted>resets {relative(row.fiveHourResetAt)}</Muted>
                </TableCell>
                <TableCell>
                  <span className={TONE_TEXT[utilTone(row.sevenDayUtilization)]}>
                    {ratio(row.sevenDayUtilization)}
                  </span>
                  <Meter
                    value={row.sevenDayUtilization}
                    tone={meterTone(row.sevenDayUtilization)}
                    label="7-day utilisation"
                  />
                  <Muted>resets {relative(row.sevenDayResetAt)}</Muted>
                </TableCell>
                <TableCell>
                  {row.claim === null ? <Muted>n/a</Muted> : <Pill tone="info">{row.claim}</Pill>}
                </TableCell>
                <TableCell>
                  {row.overageStatus === null ? (
                    <Muted>n/a</Muted>
                  ) : (
                    <Pill
                      tone={row.overageStatus === "allowed" ? "ok" : "warn"}
                      title={row.overageReason ?? undefined}
                    >
                      {row.overageStatus}
                    </Pill>
                  )}
                </TableCell>
                <TableCell>
                  <Muted>{when(row.observedAt)}</Muted>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        </QueryState>
      </Card>
    </>
  );
}
