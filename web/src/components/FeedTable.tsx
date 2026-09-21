/**
 * The request feed table, shared by the live view and any filtered history.
 *
 * Kept separate from both pages because the live feed and the paged feed must
 * render a row identically — the moment they diverge, a row that scrolls from
 * "live" into "history" appears to change, and a reader reasonably concludes
 * the data is unstable.
 */

import type { FeedRowWire } from "../../../shared/api.ts";
import { Muted, Pill, Table } from "./ui.tsx";
import { cacheWriteTokens, contextTokens, cost, modelLabel, ms, num, originLabel, userLabel, when } from "../lib/format.ts";

const STATUS_TONE: Readonly<Record<string, "ok" | "warn" | "bad" | "muted">> = {
  ok: "ok",
  client_abort: "muted",
  stream_error: "bad",
  upstream_error: "bad",
  identity_denied: "warn",
  bad_request: "warn",
};

export const FEED_HEAD = [
  "Time",
  "Developer",
  "Model",
  "Credential",
  "Status",
  "Context",
  "Cache write",
  "Output",
  "TTFB",
  "Duration",
  "Cost",
] as const;

export function FeedTable({
  rows,
  newIds,
}: {
  rows: readonly FeedRowWire[];
  /** Ids to flash as newly arrived. Empty on the paged view. */
  newIds?: ReadonlySet<string>;
}): React.JSX.Element {
  return (
    <Table head={[...FEED_HEAD]}>
      {rows.map((row) => (
        <tr key={row.id} className={newIds?.has(row.id) === true ? "is-new" : undefined}>
          <td>
            <Muted>{when(row.startedAt)}</Muted>
          </td>
          <td>
            {row.userId === null ? (
              <Pill tone="warn" title="No Fest identity token was presented, so this usage lands in nobody's column.">
                unattributed
              </Pill>
            ) : (
              userLabel(row.userId)
            )}
          </td>
          <td className="mono">{modelLabel(row.servedModel)}</td>
          <td>
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
          </td>
          <td>
            <Pill tone={STATUS_TONE[row.status] ?? "muted"} title={row.errorType ?? undefined}>
              {row.status}
              {row.httpStatus !== null && row.status !== "ok" ? ` ${row.httpStatus}` : ""}
            </Pill>
            {row.partial && (
              <>
                {" "}
                <Pill tone="warn" title="The stream ended early, so these token counts are real but incomplete.">
                  partial
                </Pill>
              </>
            )}
          </td>
          <td className="num">{num(contextTokens(row.usage))}</td>
          <td className="num">
            {cacheWriteTokens(row.usage) === 0 ? (
              <Muted>0</Muted>
            ) : (
              num(cacheWriteTokens(row.usage))
            )}
          </td>
          <td className="num">{num(row.usage.outputTokens)}</td>
          <td className="num">{ms(row.ttfbMs)}</td>
          <td className="num">{ms(row.durationMs)}</td>
          <td className="num">
            {row.costBasis === "subscription" ? (
              <Muted title="A developer's own subscription absorbed this request. It is not free — it consumed their rate-limit window — but it produced no org spend.">
                subscription
              </Muted>
            ) : (
              cost(row.costUsd)
            )}
          </td>
        </tr>
      ))}
    </Table>
  );
}
