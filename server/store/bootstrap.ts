/**
 * First-run bootstrap.
 *
 * Fest ships single-org: one row, seeded on first boot. Every table already
 * carries `org_id` so that stays an implementation detail rather than a
 * migration later.
 */

import type { Store } from "./db.ts";
import { newId } from "./ids.ts";

export const DEFAULT_ORG_SLUG = "default";

export interface Org {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface User {
  readonly id: string;
  readonly orgId: string;
  readonly email: string;
  readonly role: "owner" | "admin" | "member";
}

export function ensureOrg(store: Store, slug = DEFAULT_ORG_SLUG, name = "Default"): Org {
  const existing = store.db
    .prepare(`SELECT id, slug, name FROM orgs WHERE slug = ?`)
    .get(slug) as { id: string; slug: string; name: string } | undefined;
  if (existing !== undefined) return existing;

  const org: Org = { id: newId("org"), slug, name };
  store.db
    .prepare(`INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, ?, ?)`)
    .run(org.id, org.slug, org.name, Date.now());
  return org;
}

/**
 * Idempotent by (org, email) so `seed` can be re-run safely — which matters
 * because migrations and seeding both run on boot in a container.
 */
export function ensureUser(
  store: Store,
  args: { orgId: string; email: string; role?: "owner" | "admin" | "member"; displayName?: string },
): User {
  const existing = store.db
    .prepare(`SELECT id, org_id, email, role FROM users WHERE org_id = ? AND email = ?`)
    .get(args.orgId, args.email) as
    | { id: string; org_id: string; email: string; role: User["role"] }
    | undefined;
  if (existing !== undefined) {
    return { id: existing.id, orgId: existing.org_id, email: existing.email, role: existing.role };
  }

  const user: User = {
    id: newId("usr"),
    orgId: args.orgId,
    email: args.email,
    role: args.role ?? "member",
  };
  store.db
    .prepare(
      `INSERT INTO users (id, org_id, email, display_name, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(user.id, user.orgId, user.email, args.displayName ?? "", user.role, Date.now());
  return user;
}

export function findUserByEmail(store: Store, orgId: string, email: string): User | null {
  const row = store.db
    .prepare(`SELECT id, org_id, email, role FROM users WHERE org_id = ? AND email = ?`)
    .get(orgId, email) as
    | { id: string; org_id: string; email: string; role: User["role"] }
    | undefined;
  if (row === undefined) return null;
  return { id: row.id, orgId: row.org_id, email: row.email, role: row.role };
}
