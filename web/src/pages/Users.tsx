/**
 * Per-developer usage.
 *
 * The unattributed row is the point of this screen as much as the named ones:
 * `userId: ""` with no email means somebody is pointing Claude Code at Fest
 * without an identity token, so their usage lands in nobody's column. It is
 * called out rather than sorted quietly to the bottom, because the fix is a
 * one-line config change on that developer's machine and nobody will make it
 * if the dashboard does not say so.
 */

import { useQuery } from "@tanstack/react-query";
import { api, type Range } from "../lib/api.ts";
import { Card, Muted, Pill, QueryState, Table, TableCell, TableRow } from "../components/ui.tsx";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";
import { contextTokens, costTotal, num, personLabel, ratio, tokens } from "../lib/format.ts";

export function UsersPage({ range }: { range: Range }): React.JSX.Element {
  const users = useQuery({
    queryKey: ["users", range.fromMs, range.toMs],
    queryFn: () => api.users(range),
  });

  const rows = [...(users.data?.rows ?? [])].sort((a, b) => b.requests - a.requests);
  const unattributed = rows.find((r) => r.userId === "");

  return (
    <>
      {unattributed !== undefined && unattributed.requests > 0 && (
        <Alert variant="warning" className="mb-4">
          <AlertDescription>
            {num(unattributed.requests)} request{unattributed.requests === 1 ? "" : "s"} arrived
            with no Fest identity token and could not be attributed to anyone. Issue a token with{" "}
            <code className="mono">fest token create &lt;email&gt;</code> and set{" "}
            <code className="mono">FEST_REQUIRE_IDENTITY=true</code> once every developer has one.
          </AlertDescription>
        </Alert>
      )}

      <Card
        title="Usage by developer"
        subtitle="Subscription requests are counted, never priced: they consumed a developer's own rate-limit window rather than org budget."
      >
        <QueryState
          isPending={users.isPending}
          error={users.error}
          isEmpty={rows.length === 0}
        >
          <Table
            head={[
              "Developer",
              "Requests",
              "On subscription",
              "Errors",
              "Context",
              "Output",
              "Cache hit",
              "Org spend",
            ]}
          >
            {rows.map((row) => (
              <TableRow key={row.userId === "" ? "unattributed" : row.userId}>
                <TableCell>
                  {row.userId === "" ? (
                    <Pill tone="warn" title="No identity token was presented on these requests.">
                      unattributed
                    </Pill>
                  ) : (
                    personLabel(row.userId, row.email)
                  )}
                </TableCell>
                <TableCell className="num">{num(row.requests)}</TableCell>
                <TableCell className="num">
                  {row.subscriptionRequests === row.requests ? (
                    <span className="text-status-ok">all</span>
                  ) : (
                    num(row.subscriptionRequests)
                  )}
                </TableCell>
                <TableCell className="num">
                  {row.errors === 0 ? <Muted>0</Muted> : <span className="text-status-bad">{row.errors}</span>}
                </TableCell>
                <TableCell className="num">{tokens(contextTokens(row.usage))}</TableCell>
                <TableCell className="num">{tokens(row.usage.outputTokens)}</TableCell>
                <TableCell className="num">{ratio(row.cacheHitRatio)}</TableCell>
                <TableCell className="num">
                  {row.subscriptionRequests === row.requests ? (
                    <Muted>none</Muted>
                  ) : (
                    costTotal(row)
                  )}
                </TableCell>
              </TableRow>
            ))}
          </Table>
        </QueryState>
      </Card>
    </>
  );
}
