/**
 * The audit log: administrative actions, as a record rather than a debug log.
 *
 * Separate from `log.ts` on purpose. Application logs rotate, are filtered by
 * level, and are the first thing lost when a container is replaced — but "who
 * minted this token, and when" is asked months later, often by someone who was
 * not there. So it is a table, it is queried by the dashboard, and it survives
 * exactly as long as the database does.
 *
 * What must never appear here: a credential, a prompt, a completion. `detail`
 * is for identifiers and decisions. There is a test that greps the whole table
 * for secret-shaped strings.
 */

import type { Store } from "./db.ts";

export type AuditOutcome = "ok" | "denied" | "error";

export interface AuditEntry {
  readonly orgId: string;
  /** Null when the actor never authenticated — a failed login has no user. */
  readonly actorUserId?: string | null;
  /** What the actor called themselves: an email, or "cli" for a host command. */
  readonly actorLabel: string;
  readonly action: string;
  readonly target?: string;
  readonly outcome: AuditOutcome;
  readonly detail?: Record<string, unknown>;
  readonly ip?: string;
  readonly at?: number;
}

export interface AuditRow {
  readonly seq: number;
  readonly at: number;
  readonly actorUserId: string | null;
  readonly actorLabel: string;
  readonly action: string;
  readonly target: string;
  readonly outcome: AuditOutcome;
  readonly detail: Record<string, unknown>;
  readonly ip: string;
}

export function recordAudit(store: Store, entry: AuditEntry): void {
  store.db
    .prepare(
      `INSERT INTO audit_log
         (org_id, at, actor_user_id, actor_label, action, target, outcome, detail_json, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.orgId,
      entry.at ?? Date.now(),
      entry.actorUserId ?? null,
      entry.actorLabel.slice(0, 200),
      entry.action,
      entry.target ?? "",
      entry.outcome,
      JSON.stringify(entry.detail ?? {}),
      (entry.ip ?? "").slice(0, 64),
    );
}

export function listAudit(
  store: Store,
  orgId: string,
  opts: { limit?: number | undefined; beforeSeq?: number | undefined } = {},
): AuditRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = store.db
    .prepare(
      `SELECT seq, at, actor_user_id, actor_label, action, target, outcome, detail_json, ip
         FROM audit_log
        WHERE org_id = ? AND (? IS NULL OR seq < ?)
        ORDER BY seq DESC
        LIMIT ?`,
    )
    .all(orgId, opts.beforeSeq ?? null, opts.beforeSeq ?? null, limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    seq: Number(r["seq"]),
    at: Number(r["at"]),
    actorUserId: r["actor_user_id"] === null ? null : String(r["actor_user_id"]),
    actorLabel: String(r["actor_label"] ?? ""),
    action: String(r["action"]),
    target: String(r["target"] ?? ""),
    outcome: String(r["outcome"]) as AuditOutcome,
    detail: parseDetail(r["detail_json"]),
    ip: String(r["ip"] ?? ""),
  }));
}

function parseDetail(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
