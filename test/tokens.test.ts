import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, migrate } from "../server/store/db.ts";
import type { Store } from "../server/store/db.ts";
import { ensureOrg, ensureUser, findUserByEmail } from "../server/store/bootstrap.ts";
import {
  createToken,
  resolveToken,
  revokeToken,
  listTokens,
  createLastUsedTracker,
} from "../server/store/tokens.ts";

function freshStore(t: any): { store: Store; orgId: string; userId: string } {
  const dir = mkdtempSync(join(tmpdir(), "fest-tok-"));
  const store = openStore(join(dir, "fest.db"));
  migrate(store);
  const org = ensureOrg(store);
  const user = ensureUser(store, { orgId: org.id, email: "dev@corp.test" });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, orgId: org.id, userId: user.id };
}

test("a minted token resolves to its owner", (t) => {
  const { store, orgId, userId } = freshStore(t);
  const created = createToken(store, { orgId, userId, name: "laptop" });

  assert.ok(created.raw.startsWith("fest_"));
  const resolved = resolveToken(store, created.raw);
  assert.deepEqual(resolved, { tokenId: created.id, orgId, userId });
});

test("the raw token is never stored, only its hash and a display prefix", (t) => {
  const { store, orgId, userId } = freshStore(t);
  const created = createToken(store, { orgId, userId });

  const row = store.db
    .prepare("SELECT token_hash, token_prefix FROM identity_tokens WHERE id = ?")
    .get(created.id) as { token_hash: string; token_prefix: string };

  // The secret must not be recoverable from the database.
  assert.notEqual(row.token_hash, created.raw);
  assert.ok(!row.token_hash.includes(created.raw.slice(5)));
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  // The prefix is display-only: enough to identify, far too short to use.
  assert.ok(created.raw.startsWith(row.token_prefix));
  assert.ok(row.token_prefix.length <= 11);

  // And nothing anywhere in the row dump leaks the secret's body.
  const all = JSON.stringify(
    store.db.prepare("SELECT * FROM identity_tokens WHERE id = ?").get(created.id),
  );
  assert.ok(!all.includes(created.raw));
});

test("unknown, revoked and expired tokens are indistinguishable — all null", (t) => {
  const { store, orgId, userId } = freshStore(t);

  // Unknown.
  assert.equal(resolveToken(store, "fest_nosuchtokenatall"), null);
  assert.equal(resolveToken(store, null), null);
  assert.equal(resolveToken(store, ""), null);

  // Revoked.
  const revoked = createToken(store, { orgId, userId });
  assert.ok(resolveToken(store, revoked.raw) !== null);
  assert.equal(revokeToken(store, orgId, revoked.id), true);
  assert.equal(resolveToken(store, revoked.raw), null);
  // Revoking twice is not an error, but reports no change.
  assert.equal(revokeToken(store, orgId, revoked.id), false);

  // Expired.
  const expired = createToken(store, { orgId, userId, expiresAt: Date.now() - 1000 });
  assert.equal(resolveToken(store, expired.raw), null);

  // Not yet expired.
  const live = createToken(store, { orgId, userId, expiresAt: Date.now() + 60_000 });
  assert.ok(resolveToken(store, live.raw) !== null);
});

test("revoke is org-scoped, so one tenant cannot revoke another's token", (t) => {
  const { store, orgId, userId } = freshStore(t);
  const other = ensureOrg(store, "other", "Other");
  const created = createToken(store, { orgId, userId });

  assert.equal(revokeToken(store, other.id, created.id), false);
  // Still live.
  assert.ok(resolveToken(store, created.raw) !== null);
});

test("tokens are unique per mint", (t) => {
  const { store, orgId, userId } = freshStore(t);
  const seen = new Set<string>();
  for (let i = 0; i < 25; i += 1) seen.add(createToken(store, { orgId, userId }).raw);
  assert.equal(seen.size, 25);
});

test("listTokens reports state without exposing secrets", (t) => {
  const { store, orgId, userId } = freshStore(t);
  const a = createToken(store, { orgId, userId, name: "laptop" });
  const b = createToken(store, { orgId, userId, name: "ci" });
  revokeToken(store, orgId, b.id);

  const rows = listTokens(store, orgId);
  assert.equal(rows.length, 2);
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get(a.id)?.revokedAt, null);
  assert.ok((byId.get(b.id)?.revokedAt ?? 0) > 0);
  assert.equal(byId.get(a.id)?.lastUsedAt, null);

  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes(a.raw));
  assert.ok(!dump.includes(b.raw));
});

test("last-used tracking is coalesced, not written per request", (t) => {
  const { store, orgId, userId } = freshStore(t);
  const created = createToken(store, { orgId, userId });
  // A long interval so only the explicit flush writes.
  const tracker = createLastUsedTracker(store, 60_000);

  const read = (): number | null => {
    const r = store.db
      .prepare("SELECT last_used_at FROM identity_tokens WHERE id = ?")
      .get(created.id) as { last_used_at: number | null };
    return r.last_used_at;
  };

  // Many touches must not mean many writes: doing this per request would
  // roughly double the write volume of the whole system.
  for (let i = 0; i < 50; i += 1) tracker.touch(created.id);
  assert.equal(read(), null);

  tracker.flush();
  assert.ok((read() ?? 0) > 0);
  tracker.stop();
});

test("bootstrap is idempotent so seeding can run on every boot", (t) => {
  const { store, orgId } = freshStore(t);
  const again = ensureOrg(store);
  assert.equal(again.id, orgId);

  const u1 = ensureUser(store, { orgId, email: "dup@corp.test" });
  const u2 = ensureUser(store, { orgId, email: "dup@corp.test" });
  assert.equal(u1.id, u2.id);

  assert.equal(findUserByEmail(store, orgId, "dup@corp.test")?.id, u1.id);
  assert.equal(findUserByEmail(store, orgId, "nobody@corp.test"), null);
});
