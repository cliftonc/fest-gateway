/**
 * Dashboard accounts: granting sign-in, and checking a sign-in attempt.
 *
 * A `users` row is an attribution target — `fest token create` makes one for
 * every developer so their usage has somewhere to land. Being able to sign in
 * to the console is a *separate* grant, represented by a non-null
 * `password_hash`. Nobody acquires an admin console account as a side effect of
 * being metered.
 */

import type { Store } from "../store/db.ts";
import { ensureUser, findUserByEmail } from "../store/bootstrap.ts";
import type { User } from "../store/bootstrap.ts";
import { hashPassword, verifyPassword, needsRehash, validatePassword } from "./password.ts";
import { revokeUserSessions } from "./session.ts";

export type Role = "owner" | "admin" | "member";

/** Normalised so `Ada@Corp.test` and `ada@corp.test` are the same account. */
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

export function hasAnyOwner(store: Store, orgId: string): boolean {
  const row = store.db
    .prepare(
      `SELECT 1 AS present FROM users
        WHERE org_id = ? AND role = 'owner' AND password_hash IS NOT NULL AND disabled_at IS NULL
        LIMIT 1`,
    )
    .get(orgId) as { present?: number } | undefined;
  return row !== undefined;
}

export function countDashboardAccounts(store: Store, orgId: string): number {
  const row = store.db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND password_hash IS NOT NULL`)
    .get(orgId) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * Grant or re-grant console access. Idempotent on (org, email).
 *
 * Every password change revokes that user's existing sessions. A password is
 * changed because it may be known to someone else; leaving their cookies
 * working would make the change ceremonial.
 */
export async function grantDashboardAccess(
  store: Store,
  args: { orgId: string; email: string; password: string; role?: Role; displayName?: string },
): Promise<User> {
  const problem = validatePassword(args.password);
  if (problem !== null) throw new Error(problem);

  const email = normaliseEmail(args.email);
  const user = ensureUser(store, {
    orgId: args.orgId,
    email,
    role: args.role ?? "admin",
    ...(args.displayName === undefined ? {} : { displayName: args.displayName }),
  });

  const encoded = await hashPassword(args.password);
  store.db
    .prepare(`UPDATE users SET password_hash = ?, password_set_at = ?, role = ? WHERE id = ?`)
    .run(encoded, Date.now(), args.role ?? user.role, user.id);
  revokeUserSessions(store, user.id);

  return { ...user, role: args.role ?? user.role };
}

export interface AuthOutcome {
  readonly ok: boolean;
  readonly user: User | null;
  /** For the audit log only. Never returned to the client. */
  readonly reason: "ok" | "no_such_account" | "no_password" | "disabled" | "bad_password";
}

/**
 * Check an email/password pair.
 *
 * A miss still runs one scrypt over a dummy hash. Without it, "no such account"
 * returns in microseconds while a real account takes ~100ms, which enumerates
 * valid emails from a stopwatch.
 */
export async function authenticate(
  store: Store,
  orgId: string,
  email: string,
  password: string,
): Promise<AuthOutcome> {
  const row = store.db
    .prepare(
      `SELECT id, org_id, email, role, password_hash, disabled_at
         FROM users WHERE org_id = ? AND email = ?`,
    )
    .get(orgId, normaliseEmail(email)) as
    | {
        id: string;
        org_id: string;
        email: string;
        role: Role;
        password_hash: string | null;
        disabled_at: number | null;
      }
    | undefined;

  if (row === undefined || row.password_hash === null) {
    await verifyPassword(password, await timingEqualiser());
    return { ok: false, user: null, reason: row === undefined ? "no_such_account" : "no_password" };
  }
  if (row.disabled_at !== null) {
    await verifyPassword(password, await timingEqualiser());
    return { ok: false, user: null, reason: "disabled" };
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return { ok: false, user: null, reason: "bad_password" };

  // Opportunistic upgrade: the only moment the plaintext is available with the
  // user's consent is a successful login.
  if (needsRehash(row.password_hash)) {
    const upgraded = await hashPassword(password);
    store.db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(upgraded, row.id);
  }

  return {
    ok: true,
    user: { id: row.id, orgId: row.org_id, email: row.email, role: row.role },
    reason: "ok",
  };
}

/**
 * A real, valid encoding of a password nobody knows, so the miss path costs the
 * same as the hit path. Computed on first use rather than at import, so the
 * ~100ms scrypt lands on the first login attempt instead of on every CLI
 * invocation that happens to import this module.
 */
let dummyHash: Promise<string> | null = null;
function timingEqualiser(): Promise<string> {
  dummyHash ??= hashPassword("fest-dummy-password-for-timing-equalisation");
  return dummyHash;
}

export { findUserByEmail };
