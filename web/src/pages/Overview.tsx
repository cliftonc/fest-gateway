/**
 * Overview: traffic, cache behaviour, latency, and the health of the metering
 * pipeline itself.
 *
 * That last one is not padding. The sink drops the oldest record when its queue
 * is full, by design — the proxy degrades its metrics before it degrades a
 * developer's stream. A dashboard that hid the drop counter would silently
 * under-report and look perfectly healthy doing it, so the counter is on the
 * front page rather than in a debug endpoint.
 */

import { useQuery } from "@tanstack/react-query";
import { api, type Range } from "../lib/api.ts";
import { isExactRange } from "../lib/range.ts";
import { Card, Muted, QueryState, Stat, StatRow } from "../components/ui.tsx";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";
import { LatencyChart, Legend, TrafficChart } from "../components/charts.tsx";
import { useStatusColors } from "../lib/colors.ts";
import { contextTokens, costTotal, ms, num, ratio, tokens } from "../lib/format.ts";

export function OverviewPage({ range }: { range: Range }): React.JSX.Element {
  const c = useStatusColors();
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

  const d = overview.data;
  const totals = d?.totals;
  const sink = d?.sink;
  const exact = isExactRange(range);

  return (
    <>
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
          </StatRow>
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

      <div className="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] gap-4">
        <Card
          title="Latency"
          subtitle={
            exact
              ? "Exact: this range is short enough that the server reads raw request rows."
              : "Percentiles are interpolated from six fixed buckets — a p95 of 24s means “somewhere in 10–30s”. Narrow the range to under two hours for exact figures."
          }
        >
          <QueryState isPending={overview.isPending} error={overview.error} isEmpty={(d?.latency.count ?? 0) === 0}>
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
              <Stat label="Last flush" value={sink?.lastFlushMs === null || sink === undefined ? "—" : ms(sink.lastFlushMs)} />
            </StatRow>
            {sink !== undefined && sink.trailErrors > 0 && (
              <p>
                <Muted>
                  {num(sink.trailErrors)} JSONL trail write{sink.trailErrors === 1 ? "" : "s"}{" "}
                  failed. The trail is a convenience copy; the database is the record, so this is
                  not data loss.
                </Muted>
              </p>
            )}
          </QueryState>
        </Card>
      </div>
    </>
  );
}
