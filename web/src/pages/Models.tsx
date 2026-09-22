/**
 * Per-model usage.
 *
 * Cache write columns are split 5m/1h rather than totalled because they are
 * priced differently and Claude Code uses the 1-hour TTL — a combined figure
 * would hide the bucket that actually dominates the bill on the metered path.
 *
 * A `servedModel` of `""` means Fest never resolved which model answered. That
 * is a metering gap, not a model, so it is labelled `unresolved` rather than
 * being dropped from the table.
 */

import { useQuery } from "@tanstack/react-query";
import { api, type Range } from "../lib/api.ts";
import { Card, Muted, QueryState, Table, TableCell, TableRow } from "../components/ui.tsx";
import { costTotal, modelLabel, num, ratio, tokens } from "../lib/format.ts";

export function ModelsPage({ range }: { range: Range }): React.JSX.Element {
  const models = useQuery({
    queryKey: ["models", range.fromMs, range.toMs],
    queryFn: () => api.models(range),
  });

  const rows = [...(models.data?.rows ?? [])].sort((a, b) => b.requests - a.requests);

  return (
    <Card
      title="Usage by model"
      subtitle="Token buckets are disjoint billing buckets — input excludes cache reads and writes — so the columns add up to context, not to a double count."
    >
      <QueryState isPending={models.isPending} error={models.error} isEmpty={rows.length === 0}>
        <Table
          head={[
            "Model",
            "Requests",
            "Input",
            "Cache read",
            "Cache write 5m",
            "Cache write 1h",
            "Output",
            "Cache hit",
            "Org spend",
          ]}
        >
          {rows.map((row) => (
            <TableRow key={row.servedModel === "" ? "unresolved" : row.servedModel}>
              <TableCell className="mono" title={row.servedModel}>
                {row.servedModel === "" ? <Muted>unresolved</Muted> : modelLabel(row.servedModel)}
              </TableCell>
              <TableCell className="num">{num(row.requests)}</TableCell>
              <TableCell className="num">{tokens(row.usage.inputTokens)}</TableCell>
              <TableCell className="num">{tokens(row.usage.cacheReadTokens)}</TableCell>
              <TableCell className="num">{tokens(row.usage.cacheWrite5mTokens)}</TableCell>
              <TableCell className="num">{tokens(row.usage.cacheWrite1hTokens)}</TableCell>
              <TableCell className="num">{tokens(row.usage.outputTokens)}</TableCell>
              <TableCell className="num">{ratio(row.cacheHitRatio)}</TableCell>
              <TableCell className="num">
                {row.subscriptionRequests === row.requests ? <Muted>none</Muted> : costTotal(row)}
              </TableCell>
            </TableRow>
          ))}
        </Table>
      </QueryState>
    </Card>
  );
}
