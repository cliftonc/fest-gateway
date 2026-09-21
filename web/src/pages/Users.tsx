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
import { Card, Muted, Pill, QueryState, Table } from "../components/ui.tsx";
import { contextTokens, costTotal, num, ratio, tokens } from "../lib/format.ts";

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
        <div className="banner">
          {num(unattributed.requests)} request{unattributed.requests === 1 ? "" : "s"} arrived with
          no Fest identity token and could not be attributed to anyone. Issue a token with{" "}
          <code>fest token create &lt;email&gt;</code> and set{" "}
          <code>FEST_REQUIRE_IDENTITY=true</code> once every developer has one.
        </div>
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
              <tr key={row.userId === "" ? "unattributed" : row.userId}>
                <td>
                  {row.userId === "" ? (
                    <Pill tone="warn" title="No identity token was presented on these requests.">
                      unattributed
                    </Pill>
                  ) : (
                    (row.email ?? row.userId)
                  )}
                </td>
                <td className="num">{num(row.requests)}</td>
                <td className="num">
                  {row.subscriptionRequests === row.requests ? (
                    <span className="tone-ok">all</span>
                  ) : (
                    num(row.subscriptionRequests)
                  )}
                </td>
                <td className="num">{row.errors === 0 ? <Muted>0</Muted> : <span className="tone-bad">{row.errors}</span>}</td>
                <td className="num">{tokens(contextTokens(row.usage))}</td>
                <td className="num">{tokens(row.usage.outputTokens)}</td>
                <td className="num">{ratio(row.cacheHitRatio)}</td>
                <td className="num">
                  {row.subscriptionRequests === row.requests ? (
                    <Muted>none</Muted>
                  ) : (
                    costTotal(row)
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </QueryState>
      </Card>
    </>
  );
}
