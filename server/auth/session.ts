/**
 * Dashboard sessions: an opaque cookie, hashed at rest.
 *
 * A cookie rather than a JWT. Fest already has a database on the cold path, and
 * the property that matters for an admin console is *instant revocation* —
 * "sign out everywhere" has to mean it. A stateless token cannot do that
 * without a revocation table, at which point it is a session with extra steps
 * and a signing key to lose.
 *
 * Two clocks, deliberately:
 *   - `last_seen_at` + IDLE_MS   — an unattended console stops working.
 *   - `expires_at`   (absolute)  — a stolen cookie has a bounded life even if
 *                                  the thief keeps it warm.
 *
 * NOT ON THE HOT PATH. These are synchronous SQLite reads, which is only
 * acceptable because the proxy path never calls them — see the guardrail
 * comment in store/db.ts.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "../store/db.ts";
import { newId } from "../store/ids.ts";

const TOKEN_BYTES = 32;

export const IDLE_MS = 12 * 3_600_000;
export const ABSOLUTE_MS = 14 * 86_400_000;

/**
 * `__Host-` is not cosmetic: it makes the browser refuse the cookie unless it
 * is Secure, host-only and path `/`, which removes cookie-fixation from a
 * sibling subdomain. It requires HTTPS, so plain-HTTP deployments (a loopback
 * trial) get the unprefixed name.
 */
export const COOKIE_NAME = "fest_session";
export const SECURE_COOKIE_NAME = "__Host-fest_session";

export interface SessionUser {
  readonly userId: string;
  readonly orgId: string;
  readonly email: string;
  readonly role: "owner" | "admin" | "member";
}

export interface Session extends SessionUser {
  readonly sessionId: string;
  readonly expiresAt: number;
}

const hash = (raw: string): string => createHash("sha256").update(raw, "utf8").digest("hex");

export function cookieName(secure: boolean): string {
  return secure ? SECURE_COOKIE_NAME : COOKIE_NAME;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k !== "") out[k] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function serializeCookie(
  raw: string,
  opts: { secure: boolean; maxAgeSeconds: number },
): string {
  const parts = [
    `${cookieName(opts.secure)}=${raw}`,
    "Path=/",
    "HttpOnly",
    // Strict, not Lax. The dashboard is never linked to from elsewhere, so
    // nothing legitimate arrives cross-site, and Strict is a second line behind
    // the Origin check for unsafe methods.
    "SameSite=Strict",
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedCookie(secure: boolean): string {
  const parts = [`${cookieName(secure)}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export interface CreatedSession {
  readonly sessionId: string;
  /** The only time the raw value exists outside the operator's browser. */
  readonly raw: string;
  readonly expiresAt: number;
}

export function createSession(
  store: Store,
  args: { orgId: string; userId: string; userAgent?: string; ip?: string; now?: number },
): CreatedSession {
  const now = args.now ?? Date.now();
  const raw = randomBytes(TOKEN_BYTES).toString("base64url");
  const sessionId = newId("ses");
  const expiresAt = now + ABSOLUTE_MS;

  store.db
    .prepare(
      `INSERT INTO sessions
         (id, org_id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      args.orgId,
      args.userId,
      hash(raw),
      now,
      expiresAt,
      now,
      (args.userAgent ?? "").slice(0, 200),
      (args.ip ?? "").slice(0, 64),
    );

  return { sessionId, raw, expiresAt };
}

/**
 * Resolve a presented cookie, rolling the idle clock forward.
 *
 * Returns null for absent, unknown, revoked, idle-expired and absolutely
 * expired alike. The caller cannot tell them apart, and must not be able to:
 * distinguishing "revoked" from "never existed" is an oracle for which sessions
 * once existed.
 *
 * The role and email are read through a join rather than copied into the
 * session at login, so a demotion or a disabled account takes effect on the
 * next request instead of whenever the operator happens to sign out.
 */
export function resolveSession(store: Store, raw: string | null | undefined, now = Date.now()): Session | null {
  if (raw === null || raw === undefined || raw.length === 0) return null;
  const presented = hash(raw);

  const row = store.db
    .prepare(
      `SELECT s.id, s.org_id, s.user_id, s.token_hash, s.expires_at, s.last_seen_at, s.revoked_at,
              u.email, u.role, u.disabled_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(presented) as
    | {
        id: string;
        org_id: string;
        user_id: string;
        token_hash: string;
        expires_at: number;
        last_seen_at: number;
        revoked_at: number | null;
        email: string;
        role: Session["role"];
        disabled_at: number | null;
      }
    | undefined;

  if (row === undefined) return null;

  const a = Buffer.from(presented, "hex");
  const b = Buffer.from(row.token_hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  if (row.revoked_at !== null) return null;
  if (row.disabled_at !== null) return null;
  if (row.expires_at <= now) return null;
  if (now - row.last_seen_at > IDLE_MS) return null;

  // Coarse: rewriting last_seen_at on every poll would turn a dashboard
  // refreshing every few seconds into a steady write stream competing with the
  // metering writer for the single SQLite writer.
  if (now - row.last_seen_at > 60_000) {
    store.db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).run(now, row.id);
  }

  return {
    sessionId: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
  };
}

export function revokeSession(store: Store, sessionId: string, now = Date.now()): boolean {
  const res = store.db
    .prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(now, sessionId);
  return Number(res.changes) > 0;
}

/** "Sign out everywhere" — and what a password change must do. */
export function revokeUserSessions(store: Store, userId: string, now = Date.now()): number {
  const res = store.db
    .prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
    .run(now, userId);
  return Number(res.changes);
}

/**
 * Delete sessions that can no longer authenticate anything.
 *
 * Rows are removed rather than left as tombstones: an expired session hash has
 * no evidentiary value — the audit log holds the record of who signed in — and
 * an unbounded table on a long-lived deployment is just a slower index.
 */
export function sweepSessions(store: Store, now = Date.now()): number {
  const res = store.db
    .prepare(`DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at < ? OR revoked_at IS NOT NULL`)
    .run(now, now - IDLE_MS);
  return Number(res.changes);
}
