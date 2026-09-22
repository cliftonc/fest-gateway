/**
 * Failures, and what they mean.
 *
 * This screen reads raw request rows regardless of the range, because the
 * hourly rollup keeps an error COUNT but not the error type or HTTP status —
 * there is nothing there to group by. So it empties once retention has removed
 * the raw rows for a range. That is the honest behaviour: a breakdown we cannot
 * compute must not be approximated into something that looks computed.
 *
 * Note which statuses matter and why:
 *
 *  - `identity_denied` is a misconfigured developer, not an outage.
 *  - `client_abort` is normal — a developer pressed escape mid-turn.
 *  - A 401 is expected periodically and is NOT an error to chase: Claude Code
 *    refreshes its own OAuth token against Anthropic directly and retries. Fest
 *    forwards the 401 untouched precisely so that latch keeps working.
 */

import { useQuery } from "@tanstack/react-query";
import { api, type Range } from "../lib/api.ts";
import { isExactRange } from "../lib/range.ts";
import {
  Card,
  Muted,
  Pill,
  QueryState,
  Stat,
  StatRow,
  Table,
  TableCell,
  TableRow,
} from "../components/ui.tsx";
import { LatencyChart } from "../components/charts.tsx";
import { ms, num } from "../lib/format.ts";

/** What an admin should do about each status, in one line. */
const MEANING: Readonly<Record<string, string>> = {
  identity_denied: "A Fest identity token was missing, unknown or revoked.",
  client_abort: "The developer cancelled mid-turn. Normal, not a fault.",
  stream_error: "The upstream stream ended badly after headers were sent.",
  upstream_error: "Anthropic (or the substitute provider) returned an error.",
  bad_request: "The request was malformed before it reached an upstream.",
};

function explain(errorType: string | null, httpStatus: number | null): string {
  if (errorType !== null && MEANING[errorType] !== undefined) return MEANING[errorType] ?? "";
  if (httpStatus === 401) {
    return "Expected: the client refreshes its own token and retries. Fest forwards 401s untouched so that works.";
  }
  if (httpStatus === 429) return "Rate limited. Check the quota panel on Routing.";
  if (httpStatus !== null && httpStatus >= 500) return "Upstream server error.";
  return "";
}

export function ErrorsPage({ range }: { range: Range }): React.JSX.Element {
  const errors = useQuery({
    queryKey: ["errors", range.fromMs, range.toMs],
    queryFn: () => api.errors(range),
  });

  const rows = errors.data?.rows ?? [];
  const total = rows.reduce((a, r) => a + r.count, 0);
  const exact = isExactRange(range);

  return (
    <>
      <Card
        title="Failures in this range"
        subtitle="Read from raw request rows, not the hourly rollup — the rollup keeps a count but not a reason. This view therefore goes blank for ranges older than raw-row retention."
      >
        <QueryState
          isPending={errors.isPending}
          error={errors.error}
          isEmpty={rows.length === 0}
          emptyText="No failures recorded in this range."
        >
          <StatRow>
            <Stat label="Failed requests" value={num(total)} tone={total > 0 ? "bad" : "ok"} />
            <Stat label="Distinct causes" value={num(rows.length)} />
          </StatRow>

          <Table head={["Cause", "HTTP", "Count", "What it means"]}>
            {rows.map((row) => (
              <TableRow key={`${row.errorType ?? "none"}:${row.httpStatus ?? "none"}`}>
                <TableCell>
                  {row.errorType === null ? (
                    <Muted>no error type</Muted>
                  ) : (
                    <Pill tone={row.errorType === "client_abort" ? "muted" : "bad"}>
                      {row.errorType}
                    </Pill>
                  )}
                </TableCell>
                <TableCell className="num">{row.httpStatus ?? <Muted>—</Muted>}</TableCell>
                <TableCell className="num">{num(row.count)}</TableCell>
                <TableCell>
                  <Muted>{explain(row.errorType, row.httpStatus)}</Muted>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        </QueryState>
      </Card>

      <Card
        title="Latency, all requests"
        subtitle={
          exact
            ? "Exact: this range reads raw request rows."
            : "Interpolated from six fixed buckets; treat the percentiles as approximate."
        }
      >
        <QueryState
          isPending={errors.isPending}
          error={errors.error}
          isEmpty={(errors.data?.latency.count ?? 0) === 0}
        >
          <StatRow>
            <Stat label="Median" value={ms(errors.data?.latency.p50Ms ?? null)} note={exact ? "exact" : "approx."} />
            <Stat label="p95" value={ms(errors.data?.latency.p95Ms ?? null)} note={exact ? "exact" : "approx."} />
            <Stat label="Slowest" value={ms(errors.data?.latency.maxDurationMs ?? null)} />
          </StatRow>
          {errors.data !== undefined && <LatencyChart buckets={errors.data.latency.buckets} />}
        </QueryState>
      </Card>
    </>
  );
}
