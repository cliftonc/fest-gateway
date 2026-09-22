/**
 * `/api/auth/cli/*` — authorising the CLI from a browser session.
 *
 * This is a credential-minting surface reachable without a POST body, so the
 * tests that matter are the ones that prove it CANNOT mint: not on a GET, not
 * cross-origin, not without a session, and never to a non-loopback address.
 * The approval page exists precisely so that an ambient cookie is not enough,
 * and a regression here would be silent — the happy path would keep working.
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
import { createServer } from "../server/http/server.ts";
import { createUsageSink } from "../server/ingest/sink.ts";
import { createLiveBus } from "../server/ingest/live-bus.ts";
import { loadConfig, type FestConfig } from "../server/config.ts";
import { clearLoginThrottle } from "../server/api/auth.ts";
import { listAudit } from "../server/store/audit.ts";

const PASSWORD = "correct horse battery staple";
const CALLBACK = "http://127.0.0.1:8865/callback";

interface Harness {
  readonly base: string;
  readonly store: Store;
  readonly orgId: string;
  readonly cookie: string;
}

async function harness(
  t: { after: (fn: () => void | Promise<void>) => void },
  overrides: Partial<FestConfig> = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "fest-cliauth-"));
  const store = openStore(join(dir, "f.db"));
  migrate(store);
  const org = ensureOrg(store);
  await grantDashboardAccess(store, {
    orgId: org.id,
    email: "ada@corp.test",
    password: PASSWORD,
    role: "owner",
  });
  clearLoginThrottle();

  const sink = createUsageSink({ path: join(dir, "usage.jsonl"), flushMs: 60_000 });
  const bus = createLiveBus();
  const config: FestConfig = {
    ...loadConfig(),
    host: "127.0.0.1",
    secureCookies: false,
    ...overrides,
  };

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
  const base = `http://127.0.0.1:${port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email: "ada@corp.test", password: PASSWORD }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  assert.notEqual(cookie, "", "harness could not sign in");

  t.after(async () => {
    bus.closeAll();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sink.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return { base, store, orgId: org.id, cookie };
}

function authorizeUrl(base: string, redirect = CALLBACK): string {
  return `${base}/api/auth/cli/authorize?cli_redirect_uri=${encodeURIComponent(redirect)}`;
}

function approveUrl(base: string, redirect = CALLBACK): string {
  return `${base}/api/auth/cli/approve?cli_redirect_uri=${encodeURIComponent(redirect)}`;
}

/** A form POST as a browser would send it: same-origin, with an Origin header. */
async function approve(
  base: string,
  opts: { cookie?: string; origin?: string | null; method?: string; redirect?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers["cookie"] = opts.cookie;
  const origin = opts.origin === undefined ? base : opts.origin;
  if (origin !== null) headers["origin"] = origin;
  return fetch(approveUrl(base, opts.redirect ?? CALLBACK), {
    method: opts.method ?? "POST",
    headers,
    redirect: "manual",
  });
}

test("a signed-in browser gets an approval page, and no token is minted by looking", async (t) => {
  const h = await harness(t);
  const res = await fetch(authorizeUrl(h.base), {
    headers: { cookie: h.cookie },
    redirect: "manual",
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const body = await res.text();
  assert.match(body, /Authorise the Fest CLI/);
  assert.match(body, /ada@corp\.test/, "the reader must see which account they are approving");
  assert.match(body, /127\.0\.0\.1:8865/, "and where the token would be delivered");

  // Rendering the page must not have created anything.
  const audits = listAudit(h.store, h.orgId, { limit: 50 }).filter((a) => a.action === "auth.cli_authorize");
  assert.equal(audits.length, 0, "a GET must never mint a token");
});

test("a page view must not be cached — it names an account and mints on submit", async (t) => {
  const h = await harness(t);
  const res = await fetch(authorizeUrl(h.base), { headers: { cookie: h.cookie } });
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
});

test("the approval page never declares a no-referrer policy", async (t) => {
  // Under `no-referrer` a browser sends `Origin: null` on a form submission,
  // and the origin check on `approve` then refuses this page's own button with
  // "cross-origin request refused". No HTTP test catches that on its own —
  // every test here sets Origin by hand, which is precisely what a real browser
  // would have stopped doing. So the policy itself is what gets asserted.
  const h = await harness(t);
  const res = await fetch(authorizeUrl(h.base), { headers: { cookie: h.cookie } });
  const body = await res.text();

  assert.doesNotMatch(res.headers.get("referrer-policy") ?? "", /no-referrer/);
  assert.doesNotMatch(body, /content=["']no-referrer/);
});

test("an Origin the browser has nulled is still refused", async (t) => {
  // The other half of the same story: nulling Origin must keep failing closed.
  // The fix is never to provoke it, not to start trusting it.
  const h = await harness(t);
  const res = await approve(h.base, { cookie: h.cookie, origin: "null" });
  assert.equal(res.status, 403);
});

test("approving mints an identity token and hands it to the loopback callback", async (t) => {
  const h = await harness(t);
  const res = await approve(h.base, { cookie: h.cookie });

  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location") ?? "");
  assert.equal(location.origin, "http://127.0.0.1:8865");
  assert.equal(location.pathname, "/callback");
  assert.equal(location.searchParams.get("email"), "ada@corp.test");

  const token = location.searchParams.get("token");
  assert.ok(token !== null && token !== "", "the callback must carry a token");

  // It has to be a real identity token, not just a well-shaped string.
  const identity = await fetch(`${h.base}/api/auth/identity`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(identity.status, 200);
  assert.equal(((await identity.json()) as { email?: string }).email, "ada@corp.test");

  const audits = listAudit(h.store, h.orgId, { limit: 50 }).filter((a) => a.action === "auth.cli_authorize");
  assert.equal(audits.length, 1, "minting a token must leave an audit trail");
});

test("approving is refused on a GET", async (t) => {
  // The entire point of the approval step: a link cannot mint.
  const h = await harness(t);
  const res = await approve(h.base, { cookie: h.cookie, method: "GET" });
  assert.equal(res.status, 405);
});

test("approving is refused cross-origin", async (t) => {
  // A form on another site, auto-submitted, with the session cookie riding
  // along. Origin is the thing that distinguishes it from the real page.
  const h = await harness(t);
  const res = await approve(h.base, { cookie: h.cookie, origin: "http://evil.test" });
  assert.equal(res.status, 403);
});

test("approving is refused with no session", async (t) => {
  const h = await harness(t);
  const res = await approve(h.base);
  assert.equal(res.status, 401);
});

test("a non-loopback callback is refused on both routes, signed in or not", async (t) => {
  const h = await harness(t);
  for (const bad of [
    "https://evil.test/steal",
    "http://evil.test/steal",
    "http://127.0.0.1.evil.test/steal",
    "ftp://127.0.0.1/steal",
  ]) {
    const view = await fetch(authorizeUrl(h.base, bad), { headers: { cookie: h.cookie } });
    assert.equal(view.status, 400, bad);
    const post = await approve(h.base, { cookie: h.cookie, redirect: bad });
    assert.equal(post.status, 400, bad);
  }
});

test("a missing callback is refused rather than defaulted", async (t) => {
  const h = await harness(t);
  const res = await fetch(`${h.base}/api/auth/cli/authorize`, { headers: { cookie: h.cookie } });
  assert.equal(res.status, 400);
});

test("with no session the browser is sent to the dashboard login, carrying the callback", async (t) => {
  const h = await harness(t);
  const res = await fetch(authorizeUrl(h.base), { redirect: "manual" });

  assert.equal(res.status, 302);
  const location = res.headers.get("location") ?? "";
  assert.match(location, /^\/\?cli_authorize=/, location);
  assert.equal(
    decodeURIComponent(location.split("cli_authorize=")[1] ?? ""),
    CALLBACK,
    "the dashboard has to know where to hand back to",
  );
});

test("the login redirect honours a mount path", async (t) => {
  const h = await harness(t, { basePath: "/fest" });
  const res = await fetch(authorizeUrl(h.base), { redirect: "manual" });
  assert.match(res.headers.get("location") ?? "", /^\/fest\/\?cli_authorize=/);
});

test("the login redirect honours a separate dashboard origin", async (t) => {
  // `npm run dev`: Vite owns the page on 5173 so it can hot-reload, and the
  // gateway on 8787 has no login screen worth redirecting to.
  const h = await harness(t, { dashboardUrl: "http://127.0.0.1:5173" });
  const res = await fetch(authorizeUrl(h.base), { redirect: "manual" });
  assert.match(res.headers.get("location") ?? "", /^http:\/\/127\.0\.0\.1:5173\/\?cli_authorize=/);
});
