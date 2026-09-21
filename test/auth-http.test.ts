/**
 * Dashboard auth over a real socket.
 *
 * The unit tests prove the pieces. This proves the wiring, which is where this
 * class of bug actually lives: an endpoint added outside the guard, a cookie
 * the browser would reject, a 401 that leaks which half of the credential was
 * wrong, or — the one that matters most here — a session check accidentally
 * applied to the proxy path, which would mean a developer has to sign in to a
 * web page before their editor works.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Server } from "node:http";
import { openStore, migrate, type Store } from "../server/store/db.ts";
import { ensureOrg } from "../server/store/bootstrap.ts";
import { grantDashboardAccess } from "../server/auth/accounts.ts";
import { clearLoginThrottle } from "../server/api/auth.ts";
import { listAudit } from "../server/store/audit.ts";
import { createServer } from "../server/http/server.ts";
import { createUsageSink } from "../server/ingest/sink.ts";
import { createLiveBus } from "../server/ingest/live-bus.ts";
import { loadConfig } from "../server/config.ts";

const PASSWORD = "a-good-long-password";

interface Harness {
  readonly base: string;
  readonly store: Store;
  readonly orgId: string;
}

async function harness(
  t: { after: (fn: () => void | Promise<void>) => void },
  opts: { withOwner?: boolean; host?: string } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "fest-authhttp-"));
  const store = openStore(join(dir, "f.db"));
  migrate(store);
  const org = ensureOrg(store);
  if (opts.withOwner !== false) {
    await grantDashboardAccess(store, {
      orgId: org.id,
      email: "ada@corp.test",
      password: PASSWORD,
      role: "owner",
    });
  }

  clearLoginThrottle();

  const sink = createUsageSink({ path: join(dir, "usage.jsonl"), flushMs: 60_000 });
  const bus = createLiveBus();
  const config = { ...loadConfig(), host: opts.host ?? "127.0.0.1", secureCookies: false };

  const server: Server = createServer({
    config,
    sink,
    bus,
    orgId: org.id,
    store,
    resolveIdentity: () => null,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  t.after(async () => {
    bus.closeAll();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sink.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return { base: `http://127.0.0.1:${port}`, store, orgId: org.id };
}

interface Reply {
  readonly status: number;
  readonly body: any;
  readonly cookie: string | null;
}

async function call(
  base: string,
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string | null; origin?: string | null } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.cookie != null) headers["cookie"] = opts.cookie;
  // Browsers always send Origin on POST, so the default here mimics one.
  const origin = opts.origin === undefined ? new URL(base).host : opts.origin;
  if (origin !== null) headers["origin"] = `http://${origin}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(base + path, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });

  const setCookie = res.headers.get("set-cookie");
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, cookie: setCookie };
}

/** The `name=value` part of a Set-Cookie, ready to send back. */
const cookiePair = (setCookie: string | null): string => (setCookie ?? "").split(";")[0] ?? "";

test("the whole sign-in round trip", async (t) => {
  const h = await harness(t);

  assert.equal((await call(h.base, "/api/overview")).status, 401);

  const me = await call(h.base, "/api/auth/me");
  assert.equal(me.status, 200, "'am I signed in' is a question anyone may ask");
  assert.equal(me.body.authenticated, false);
  assert.equal(me.body.setupRequired, false);

  const login = await call(h.base, "/api/auth/login", {
    method: "POST",
    body: { email: "ada@corp.test", password: PASSWORD },
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, "owner");
  assert.match(login.cookie ?? "", /HttpOnly/);
  assert.match(login.cookie ?? "", /SameSite=Strict/);

  const cookie = cookiePair(login.cookie);
  assert.equal((await call(h.base, "/api/overview", { cookie })).status, 200);
  assert.equal((await call(h.base, "/api/auth/me", { cookie })).body.user.email, "ada@corp.test");

  const out = await call(h.base, "/api/auth/logout", { method: "POST", cookie });
  assert.equal(out.status, 200);
  assert.match(out.cookie ?? "", /Max-Age=0/);
  assert.equal((await call(h.base, "/api/overview", { cookie })).status, 401, "the cookie is dead, not just cleared");
});

test("a wrong password and an unknown account are the same answer", async (t) => {
  const h = await harness(t);

  const wrong = await call(h.base, "/api/auth/login", {
    method: "POST",
    body: { email: "ada@corp.test", password: "nope" },
  });
  const unknown = await call(h.base, "/api/auth/login", {
    method: "POST",
    body: { email: "nobody@corp.test", password: "nope" },
  });

  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, unknown.body, "the response must not enumerate accounts");
  assert.equal(wrong.cookie, null);

  // The operator, unlike the caller, gets to know which it was.
  const reasons = listAudit(h.store, h.orgId).map((r) => r.detail["reason"]);
  assert.ok(reasons.includes("bad_password"));
  assert.ok(reasons.includes("no_such_account"));
});

test("a cross-origin login is refused before the password is even checked", async (t) => {
  const h = await harness(t);

  const evil = await call(h.base, "/api/auth/login", {
    method: "POST",
    origin: "evil.test",
    body: { email: "ada@corp.test", password: PASSWORD },
  });
  assert.equal(evil.status, 403);
  assert.equal(evil.cookie, null);

  const bare = await call(h.base, "/api/auth/login", {
    method: "POST",
    origin: null,
    body: { email: "ada@corp.test", password: PASSWORD },
  });
  assert.equal(bare.status, 403, "no Origin is refused, not waved through");
});

test("online guessing is throttled, and says so", async (t) => {
  const h = await harness(t);

  let last = 0;
  for (let i = 0; i < 12; i += 1) {
    last = (
      await call(h.base, "/api/auth/login", {
        method: "POST",
        body: { email: "ada@corp.test", password: `guess-${i}` },
      })
    ).status;
  }
  // 429 rather than another 401: retrying with the right password will not
  // help until the window passes, and the caller needs to know that.
  assert.equal(last, 429);

  // And the throttle must not lock out the real password forever — it is keyed
  // per (email, ip) and clears on success once the window passes. Here, still
  // inside the window, even the correct password is refused; that is the point.
  const correct = await call(h.base, "/api/auth/login", {
    method: "POST",
    body: { email: "ada@corp.test", password: PASSWORD },
  });
  assert.equal(correct.status, 429);
});

test("the proxy path is never behind the dashboard session", async (t) => {
  const h = await harness(t);

  // Claude Code's startup probe. If this ever needs a cookie, every developer's
  // editor breaks the moment an owner account is created.
  assert.equal((await call(h.base, "/api/hello")).status, 200);

  // And an unknown path still 404s rather than being swallowed by the guard:
  // that warn line is the early warning that a Claude Code release added an
  // endpoint.
  assert.equal((await call(h.base, "/v1/nonsense")).status, 404);
});

test("an unclaimed deployment on loopback serves the dashboard, and says setup is needed", async (t) => {
  const h = await harness(t, { withOwner: false });

  assert.equal((await call(h.base, "/api/overview")).status, 200);
  assert.equal((await call(h.base, "/api/auth/me")).body.setupRequired, true);
});

test("an unclaimed deployment off loopback serves nothing at all", async (t) => {
  // The config says 0.0.0.0 while the socket stays on loopback for the test —
  // what is under test is the decision, not the bind.
  const h = await harness(t, { withOwner: false, host: "0.0.0.0" });

  const res = await call(h.base, "/api/overview");
  assert.equal(res.status, 503);
  assert.match(String(res.body.error), /admin create/);
});

test("a member cannot read the audit log", async (t) => {
  const h = await harness(t);
  await grantDashboardAccess(h.store, {
    orgId: h.orgId,
    email: "dev@corp.test",
    password: PASSWORD,
    role: "member",
  });

  const login = await call(h.base, "/api/auth/login", {
    method: "POST",
    body: { email: "dev@corp.test", password: PASSWORD },
  });
  const cookie = cookiePair(login.cookie);

  // A member gets a member's view: their own traffic, scoped by the query
  // layer from the session's user id. That layer fails closed without one, so
  // a mis-wired scope shows up here as a 500 rather than as another developer's
  // usage.
  assert.equal((await call(h.base, "/api/overview", { cookie })).status, 200);

  // Who was granted access, and whose login failed, is not part of "the traffic
  // I am part of".
  assert.equal((await call(h.base, "/api/audit", { cookie })).status, 403);
});

test("the audit log never holds a credential", async (t) => {
  const h = await harness(t);

  await call(h.base, "/api/auth/login", {
    method: "POST",
    body: { email: "ada@corp.test", password: PASSWORD },
  });
  await call(h.base, "/api/auth/login", {
    method: "POST",
    body: { email: "ada@corp.test", password: "hunter2-LEAKCANARY" },
  });

  // The whole table, not just the fields we remembered to check.
  const dumped = JSON.stringify(
    h.store.db.prepare(`SELECT * FROM audit_log`).all(),
  );
  assert.equal(dumped.includes(PASSWORD), false, "a correct password must not be recorded");
  assert.equal(dumped.includes("LEAKCANARY"), false, "nor a wrong one — wrong passwords are often right ones, mistyped");
});

test("a GET is not accepted where a POST is required", async (t) => {
  const h = await harness(t);
  assert.equal((await call(h.base, "/api/auth/login")).status, 405);
  assert.equal((await call(h.base, "/api/auth/logout")).status, 405);
});

test("an oversized login body is rejected rather than buffered", async (t) => {
  const h = await harness(t);
  const res = await call(h.base, "/api/auth/login", {
    method: "POST",
    body: { email: "ada@corp.test", password: "x".repeat(64 * 1024) },
  });
  assert.equal(res.status, 400);
});
