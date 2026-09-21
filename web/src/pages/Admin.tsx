/**
 * The audit log.
 *
 * The one screen that is about the gateway rather than the traffic: who was
 * granted access, who signed in, whose login failed, which identity tokens
 * exist. Admin and owner only — the server enforces that; this page would
 * simply render the 403 if it did not.
 */

import { useQuery } from "@tanstack/react-query";
import { Card } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { when } from "../lib/format.ts";

const OUTCOME_TONE: Record<string, string> = { ok: "tone-ok", denied: "tone-bad", error: "tone-warn" };

export function AdminPage(): React.JSX.Element {
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api.audit() });

  if (q.isPending) return <div className="state">Loading…</div>;
  if (q.isError) {
    return (
      <Card title="Audit log">
        <p className="state bad">{q.error instanceof Error ? q.error.message : "failed"}</p>
      </Card>
    );
  }

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
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Outcome</th>
              <th>Detail</th>
              <th>From</th>
            </tr>
          </thead>
          <tbody>
            {q.data.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  Nothing recorded yet.
                </td>
              </tr>
            )}
            {q.data.rows.map((r) => (
              <tr key={r.seq}>
                <td>{when(r.at)}</td>
                <td>{r.actorLabel === "" ? <span className="muted">—</span> : r.actorLabel}</td>
                <td>{r.action}</td>
                <td className="muted">{r.target === "" ? "—" : r.target}</td>
                <td className={OUTCOME_TONE[r.outcome] ?? ""}>{r.outcome}</td>
                <td className="muted">
                  {Object.keys(r.detail).length === 0 ? "—" : JSON.stringify(r.detail)}
                </td>
                <td className="muted">{r.ip === "" ? "—" : r.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
