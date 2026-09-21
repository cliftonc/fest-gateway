/**
 * Dashboard authentication: passwords, sessions, and who the guard lets in.
 *
 * The properties under test are the ones whose absence is silent. A password
 * that verifies is obvious in ten seconds of clicking; a session that outlives
 * a disabled account, or an ownerless deployment serving usage data off
 * 0.0.0.0, is not visible until it matters.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, migrate, type Store } from "../server/store/db.ts";
import { ensureOrg, ensureUser } from "../server/store/bootstrap.ts";
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  validatePassword,
  generatePassword,
  MIN_PASSWORD_LENGTH,
} from "../server/auth/password.ts";
import {
  createSession,
  resolveSession,
  revokeSession,
  revokeUserSessions,
  sweepSessions,
  parseCookies,
  serializeCookie,
  cookieName,
  IDLE_MS,
  ABSOLUTE_MS,
} from "../server/auth/session.ts";
import { grantDashboardAccess, authenticate, hasAnyOwner, normaliseEmail } from "../server/auth/accounts.ts";
import { authorizeApi, isLoopbackHost, originAllowed } from "../server/auth/guard.ts";
import { recordAudit, listAudit } from "../server/store/audit.ts";

function freshStore(t: { after: (fn: () => void) => void }): { store: Store; orgId: string } {
  const dir = mkdtempSync(join(tmpdir(), "fest-auth-"));
  const store = openStore(join(dir, "f.db"));
  migrate(store);
  const org = ensureOrg(store);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, orgId: org.id };
}

// A request stand-in: the guard reads only headers and the socket address.
const req = (headers: Record<string, string> = {}) =>
  ({ headers, socket: { remoteAddress: "127.0.0.1" } }) as never;

// ── passwords ───────────────────────────────────────────────────────────────

test("a password verifies, and a near miss does not", async () => {
  const encoded = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", encoded), true);
  assert.equal(await verifyPassword("correct horse battery stapl", encoded), false);
  assert.equal(await verifyPassword("", encoded), false);
});

test("the same password hashes differently every time", async () => {
  const a = await hashPassword("a-sufficiently-long-password");
  const b = await hashPassword("a-sufficiently-long-password");
  // Per-password salt: otherwise one rainbow table covers every account, and
  // two users with the same password are visibly identical in the table.
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("a-sufficiently-long-password", b), true);
});

test("a corrupt stored hash reads as 'does not match', never as a crash", async () => {
  for (const bad of ["", "not-a-hash", "scrypt$x$8$1$aaaa$bbbb", "scrypt$16384$8$1$$", "bcrypt$1$2$3$4$5"]) {
    assert.equal(await verifyPassword("anything", bad), false, bad);
  }
});

test("hostile scrypt parameters in a stored hash cannot hang the process", async () => {
  // A row saying N=2^30 would otherwise ask for gigabytes and minutes.
  const started = Date.now();
  assert.equal(await verifyPassword("x", `scrypt$${2 ** 30}$8$1$aaaa$bbbb`), false);
  assert.ok(Date.now() - started < 1_000);
});

test("weaker parameters are flagged for upgrade on next login", async () => {
  const old = await hashPassword("a-sufficiently-long-password", { N: 1024, r: 8, p: 1 });
  assert.equal(needsRehash(old), true);
  assert.equal(needsRehash(await hashPassword("a-sufficiently-long-password")), false);
});

test("length is the only password rule", () => {
  assert.notEqual(validatePassword("short"), null);
  assert.equal(validatePassword("x".repeat(MIN_PASSWORD_LENGTH)), null);
  // No composition rules: "password1234" is allowed, because rules like these
  // push people to predictable shapes and scrypt is what does the work.
  assert.equal(validatePassword("password1234"), null);
  assert.notEqual(validatePassword("x".repeat(2000)), null);
});

test("a generated password is long and unique", () => {
  const seen = new Set(Array.from({ length: 50 }, () => generatePassword()));
  assert.equal(seen.size, 50);
  assert.equal(validatePassword([...seen][0]!), null);
});

// ── sessions ────────────────────────────────────────────────────────────────

test("a session resolves once and never from the database alone", async (t) => {
  const { store, orgId } = freshStore(t);
  const user = ensureUser(store, { orgId, email: "ada@corp.test", role: "owner" });
  const created = createSession(store, { orgId, userId: user.id });

  const session = resolveSession(store, created.raw);
  assert.equal(session?.userId, user.id);
  assert.equal(session?.role, "owner");

  // Only the hash is stored, so a database read cannot be replayed as a cookie.
  const row = store.db.prepare(`SELECT token_hash FROM sessions WHERE id = ?`).get(created.sessionId) as {
    token_hash: string;
  };
  assert.notEqual(row.token_hash, created.raw);
  assert.equal(resolveSession(store, row.token_hash), null);
});

test("revoked, idle, expired and unknown sessions are indistinguishable", async (t) => {
  const { store, orgId } = freshStore(t);
  const user = ensureUser(store, { orgId, email: "ada@corp.test", role: "admin" });

  const revoked = createSession(store, { orgId, userId: user.id });
  revokeSession(store, revoked.sessionId);
  assert.equal(resolveSession(store, revoked.raw), null);

  const idle = createSession(store, { orgId, userId: user.id, now: Date.now() - IDLE_MS - 1000 });
  assert.equal(resolveSession(store, idle.raw), null, "idle timeout");

  const old = createSession(store, { orgId, userId: user.id, now: Date.now() - ABSOLUTE_MS - 1000 });
  assert.equal(resolveSession(store, old.raw), null, "absolute cap");

  assert.equal(resolveSession(store, "never-issued"), null);
  assert.equal(resolveSession(store, null), null);
});

test("disabling an account kills its live sessions immediately", async (t) => {
  const { store, orgId } = freshStore(t);
  const user = ensureUser(store, { orgId, email: "ada@corp.test", role: "admin" });
  const created = createSession(store, { orgId, userId: user.id });
  assert.notEqual(resolveSession(store, created.raw), null);

  // Role and disabled state are read through a join on every request rather
  // than copied into the session at login, so this takes effect now and not at
  // the operator's next sign-in.
  store.db.prepare(`UPDATE users SET disabled_at = ? WHERE id = ?`).run(Date.now(), user.id);
  assert.equal(resolveSession(store, created.raw), null);
});

test("a role change takes effect on the next request, not the next login", async (t) => {
  const { store, orgId } = freshStore(t);
  const user = ensureUser(store, { orgId, email: "ada@corp.test", role: "owner" });
  const created = createSession(store, { orgId, userId: user.id });
  assert.equal(resolveSession(store, created.raw)?.role, "owner");

  store.db.prepare(`UPDATE users SET role = 'member' WHERE id = ?`).run(user.id);
  assert.equal(resolveSession(store, created.raw)?.role, "member");
});

test("changing a password signs that user out everywhere", async (t) => {
  const { store, orgId } = freshStore(t);
  await grantDashboardAccess(store, { orgId, email: "ada@corp.test", password: "first-password-here", role: "owner" });
  const user = store.db.prepare(`SELECT id FROM users WHERE email = ?`).get("ada@corp.test") as { id: string };

  const a = createSession(store, { orgId, userId: user.id });
  const b = createSession(store, { orgId, userId: user.id });
  assert.notEqual(resolveSession(store, a.raw), null);

  await grantDashboardAccess(store, { orgId, email: "ada@corp.test", password: "second-password-here" });

  // A password is changed because it may be known to someone else. Leaving
  // their cookies working would make the change ceremonial.
  assert.equal(resolveSession(store, a.raw), null);
  assert.equal(resolveSession(store, b.raw), null);
});

test("the sweep removes only sessions that can no longer authenticate", async (t) => {
  const { store, orgId } = freshStore(t);
  const user = ensureUser(store, { orgId, email: "ada@corp.test", role: "admin" });
  const live = createSession(store, { orgId, userId: user.id });
  createSession(store, { orgId, userId: user.id, now: Date.now() - ABSOLUTE_MS - 1 });
  const revoked = createSession(store, { orgId, userId: user.id });
  revokeSession(store, revoked.sessionId);

  assert.equal(sweepSessions(store), 2);
  assert.notEqual(resolveSession(store, live.raw), null, "a live session survives housekeeping");
});

test("revokeUserSessions is 'sign out everywhere' and nobody else's sessions", async (t) => {
  const { store, orgId } = freshStore(t);
  const ada = ensureUser(store, { orgId, email: "ada@corp.test", role: "admin" });
  const bob = ensureUser(store, { orgId, email: "bob@corp.test", role: "admin" });
  const adaSession = createSession(store, { orgId, userId: ada.id });
  const bobSession = createSession(store, { orgId, userId: bob.id });

  assert.equal(revokeUserSessions(store, ada.id), 1);
  assert.equal(resolveSession(store, adaSession.raw), null);
  assert.notEqual(resolveSession(store, bobSession.raw), null);
});

// ── cookies ─────────────────────────────────────────────────────────────────

test("the session cookie is HttpOnly, SameSite=Strict, and Secure only when told", () => {
  const plain = serializeCookie("abc", { secure: false, maxAgeSeconds: 60 });
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Strict/);
  assert.doesNotMatch(plain, /Secure/);
  assert.match(plain, /^fest_session=abc/);

  const secure = serializeCookie("abc", { secure: true, maxAgeSeconds: 60 });
  assert.match(secure, /Secure/);
  // __Host- makes the browser enforce host-only + Secure + Path=/, which
  // removes cookie fixation from a sibling subdomain.
  assert.match(secure, /^__Host-fest_session=abc/);
  assert.equal(cookieName(true), "__Host-fest_session");
});

test("cookie parsing survives the shapes browsers actually send", () => {
  assert.deepEqual(parseCookies("a=1; b=2"), { a: "1", b: "2" });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies("novalue; a=1"), { a: "1" });
  assert.deepEqual(parseCookies("a=one%20two"), { a: "one two" });
});

// ── accounts ────────────────────────────────────────────────────────────────

test("being metered does not grant a dashboard account", async (t) => {
  const { store, orgId } = freshStore(t);
  // This is what `fest token create` does for a developer.
  ensureUser(store, { orgId, email: "dev@corp.test", role: "member" });

  const outcome = await authenticate(store, orgId, "dev@corp.test", "anything-at-all");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "no_password");
  assert.equal(hasAnyOwner(store, orgId), false);
});

test("authentication reports the reason to the operator, never to the caller", async (t) => {
  const { store, orgId } = freshStore(t);
  await grantDashboardAccess(store, { orgId, email: "ada@corp.test", password: "a-good-long-password", role: "owner" });

  assert.equal((await authenticate(store, orgId, "ada@corp.test", "a-good-long-password")).ok, true);
  assert.equal((await authenticate(store, orgId, "ada@corp.test", "wrong")).reason, "bad_password");
  assert.equal((await authenticate(store, orgId, "nobody@corp.test", "wrong")).reason, "no_such_account");
});

test("a missing account costs the same as a wrong password", async (t) => {
  const { store, orgId } = freshStore(t);
  await grantDashboardAccess(store, { orgId, email: "ada@corp.test", password: "a-good-long-password", role: "owner" });

  const time = async (email: string): Promise<number> => {
    const started = process.hrtime.bigint();
    await authenticate(store, orgId, email, "some-wrong-password");
    return Number(process.hrtime.bigint() - started) / 1e6;
  };

  const known = await time("ada@corp.test");
  const unknown = await time("nobody@corp.test");
  // Without the dummy hash the miss returns in microseconds while a hit takes
  // ~100ms, which enumerates valid emails with a stopwatch.
  assert.ok(unknown > known / 4, `miss ${unknown.toFixed(1)}ms vs hit ${known.toFixed(1)}ms`);
});

test("emails are normalised, so one person is one account", async (t) => {
  const { store, orgId } = freshStore(t);
  await grantDashboardAccess(store, { orgId, email: "  Ada@Corp.TEST ", password: "a-good-long-password", role: "owner" });
  assert.equal(normaliseEmail("  Ada@Corp.TEST "), "ada@corp.test");
  assert.equal((await authenticate(store, orgId, "ADA@corp.test", "a-good-long-password")).ok, true);
});

test("a too-short password is refused at the point of being set", async (t) => {
  const { store, orgId } = freshStore(t);
  await assert.rejects(
    () => grantDashboardAccess(store, { orgId, email: "ada@corp.test", password: "short" }),
    /at least/,
  );
});

// ── the guard ───────────────────────────────────────────────────────────────

test("an unclaimed deployment is open on loopback and refuses everywhere else", async (t) => {
  const { store, orgId } = freshStore(t);
  const deps = { store, orgId, secureCookies: false };

  const loopback = authorizeApi(req(), { ...deps, bindHost: "127.0.0.1" });
  assert.equal(loopback.allow, true, "a single-developer trial needs no password");

  // The failure mode this exists to make impossible: bound to every interface,
  // no account, every developer's usage served to whoever finds the port.
  const exposed = authorizeApi(req(), { ...deps, bindHost: "0.0.0.0" });
  assert.equal(exposed.allow, false);
  assert.equal(exposed.allow === false && exposed.status, 503);
  assert.match(exposed.allow === false ? exposed.error : "", /admin create/);
});

test("once an owner exists, loopback needs a session too", async (t) => {
  const { store, orgId } = freshStore(t);
  await grantDashboardAccess(store, { orgId, email: "ada@corp.test", password: "a-good-long-password", role: "owner" });

  const denied = authorizeApi(req(), { store, orgId, bindHost: "127.0.0.1", secureCookies: false });
  assert.equal(denied.allow, false);
  assert.equal(denied.allow === false && denied.status, 401);

  const user = store.db.prepare(`SELECT id FROM users WHERE email = ?`).get("ada@corp.test") as { id: string };
  const created = createSession(store, { orgId, userId: user.id });
  const allowed = authorizeApi(req({ cookie: `fest_session=${created.raw}` }), {
    store,
    orgId,
    bindHost: "127.0.0.1",
    secureCookies: false,
  });
  assert.equal(allowed.allow, true);
  assert.equal(allowed.allow === true && allowed.session?.email, "ada@corp.test");
});

test("loopback is a fixed list, not a prefix match", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  // `127.0.0.1.evil.test` resolving publicly is exactly the trick a prefix
  // match would fall for.
  assert.equal(isLoopbackHost("127.0.0.1.evil.test"), false);
  assert.equal(isLoopbackHost("10.0.0.5"), false);
});

test("an unsafe request must carry an Origin that matches its Host", () => {
  assert.equal(originAllowed(req({ origin: "http://fest.corp", host: "fest.corp" })), true);
  assert.equal(originAllowed(req({ origin: "http://evil.test", host: "fest.corp" })), false);
  // Absent is refused rather than waved through: waving it through restores the
  // hole for any browser that omits it.
  assert.equal(originAllowed(req({ host: "fest.corp" })), false);
  assert.equal(originAllowed(req({ origin: "null", host: "fest.corp" })), false);
});

// ── audit ───────────────────────────────────────────────────────────────────

test("the audit log records the actor even when there is no user", async (t) => {
  const { store, orgId } = freshStore(t);
  recordAudit(store, { orgId, actorLabel: "attacker@evil.test", action: "auth.login", outcome: "denied" });
  const [row] = listAudit(store, orgId);
  assert.equal(row?.actorUserId, null);
  assert.equal(row?.actorLabel, "attacker@evil.test");
  assert.equal(row?.outcome, "denied");
});

test("the audit log is newest-first and pages backwards", async (t) => {
  const { store, orgId } = freshStore(t);
  for (let i = 0; i < 5; i += 1) {
    recordAudit(store, { orgId, actorLabel: "cli", action: `a${i}`, outcome: "ok" });
  }
  const page1 = listAudit(store, orgId, { limit: 2 });
  assert.deepEqual(page1.map((r) => r.action), ["a4", "a3"]);
  const page2 = listAudit(store, orgId, { limit: 2, beforeSeq: page1[1]!.seq });
  assert.deepEqual(page2.map((r) => r.action), ["a2", "a1"]);
});

test("audit rows are scoped to their org", async (t) => {
  const { store, orgId } = freshStore(t);
  const other = ensureOrg(store, "other", "Other");
  recordAudit(store, { orgId, actorLabel: "a", action: "mine", outcome: "ok" });
  recordAudit(store, { orgId: other.id, actorLabel: "b", action: "theirs", outcome: "ok" });

  assert.deepEqual(listAudit(store, orgId).map((r) => r.action), ["mine"]);
  assert.deepEqual(listAudit(store, other.id).map((r) => r.action), ["theirs"]);
});
