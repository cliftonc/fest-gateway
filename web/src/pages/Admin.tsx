/**
 * The audit log.
 *
 * The one screen that is about the gateway rather than the traffic: who was
 * granted access, who signed in, whose login failed, which identity tokens
 * exist. Admin and owner only — the server enforces that; this page would
 * simply render the 403 if it did not.
 */

import { useQuery } from "@tanstack/react-query";
import { Card, Muted, QueryState, Table, TableCell, TableRow, TONE_TEXT } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { when } from "../lib/format.ts";

const OUTCOME_TONE: Readonly<Record<string, "ok" | "bad" | "warn">> = {
  ok: "ok",
  denied: "bad",
  error: "warn",
};

export function AdminPage(): React.JSX.Element {
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api.audit() });

  return (
    <Card
      title="Audit log"
      subtitle={
        <>
          Administrative actions, kept in the database rather than the application log — logs rotate
          and containers are replaced, but “who minted this token” is asked months later. No
          credential and no prompt text is ever recorded here.
        </>
      }
    >
      <QueryState
        isPending={q.isPending}
        error={q.error}
        isEmpty={q.data !== undefined && q.data.rows.length === 0}
        emptyText="Nothing recorded yet."
      >
        <Table head={["When", "Actor", "Action", "Target", "Outcome", "Detail", "From"]}>
          {(q.data?.rows ?? []).map((r) => {
            const tone = OUTCOME_TONE[r.outcome];
            return (
            <TableRow key={r.seq}>
              <TableCell>{when(r.at)}</TableCell>
              <TableCell>{r.actorLabel === "" ? <Muted>—</Muted> : r.actorLabel}</TableCell>
              <TableCell>{r.action}</TableCell>
              <TableCell><Muted>{r.target === "" ? "—" : r.target}</Muted></TableCell>
              <TableCell className={tone === undefined ? "" : TONE_TEXT[tone]}>
                {r.outcome}
              </TableCell>
              <TableCell>
                <Muted>{Object.keys(r.detail).length === 0 ? "—" : JSON.stringify(r.detail)}</Muted>
              </TableCell>
              <TableCell><Muted>{r.ip === "" ? "—" : r.ip}</Muted></TableCell>
            </TableRow>
            );
          })}
        </Table>
      </QueryState>
    </Card>
  );
}
