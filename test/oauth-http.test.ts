/**
 * The whole OAuth wire: start -> provider -> callback, for both the dashboard
 * (session cookie) and the CLI (`fest login`'s loopback redirect) callers,
 * plus the domain allow-list and state validation that guard it.
 *
 * Google's and GitHub's actual token/profile endpoints are mocked at the
 * `fetch` layer — arctic's own HTTP calls go through global `fetch`, so this
 * exercises the real arctic client and the real callback handler, only ever
 * substituting what would otherwise be a real network call to Google/GitHub.
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
import { createServer } from "../server/http/server.ts";
import { createUsageSink } from "../server/ingest/sink.ts";
import { createLiveBus } from "../server/ingest/live-bus.ts";
import { loadConfig } from "../server/config.ts";
import { listAudit } from "../server/store/audit.ts";
import type { FestConfig } from "../server/config.ts";

interface Harness {
  readonly base: string;
  readonly store: Store;
  readonly orgId: string;
}

async function harness(
  t: { after: (fn: () => void | Promise<void>) => void },
  configOverrides: Partial<FestConfig> = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "fest-oauthhttp-"));
  const store = openStore(join(dir, "f.db"));
  migrate(store);
  const org = ensureOrg(store);

  const sink = createUsageSink({ path: join(dir, "usage.jsonl"), flushMs: 60_000 });
  const bus = createLiveBus();
  const config: FestConfig = {
    ...loadConfig(),
    host: "127.0.0.1",
    secureCookies: false,
    googleClientId: "google-id",
    googleClientSecret: "google-secret",
    githubClientId: "github-id",
    githubClientSecret: "github-secret",
    allowedEmailDomains: ["corp.test"],
    ...configOverrides,
  };

  const server: Server = createServer({ config, sink, bus, orgId: org.id, store, resolveIdentity: () => null });
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

/** All Set-Cookie `name=value` pairs from a response, ready to send back joined by `; `. */
function cookiePairs(res: Response): string[] {
  return res.headers.getSetCookie().map((c) => c.split(";")[0] ?? "");
}

async function get(
  base: string,
  path: string,
  opts: { cookies?: readonly string[]; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.cookies !== undefined && opts.cookies.length > 0) headers["cookie"] = opts.cookies.join("; ");
  return fetch(base + path, { redirect: "manual", headers });
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof Request) return input.url;
  return input.toString();
}

/** Substitutes only the prefixes it's given a response for; everything else goes to the real fetch. */
function mockUpstream(t: { mock: { method: (...a: any[]) => any } }, responses: Record<string, unknown>): void {
  const real = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: any, init?: any) => {
    const url = urlOf(input);
    const hit = Object.entries(responses).find(([prefix]) => url.startsWith(prefix));
    if (hit === undefined) return real(input, init);
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } });
  });
}

test("dashboard OAuth: start sets state+verifier cookies and redirects to Google", async (t) => {
  const h = await harness(t);
  const res = await get(h.base, "/api/auth/oauth/google/start");
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location") ?? "", /^https:\/\/accounts\.google\.com\//);
  const cookies = cookiePairs(res);
  assert.ok(cookies.some((c) => c.startsWith("fest_oauth_state=")));
  assert.ok(cookies.some((c) => c.startsWith("fest_oauth_verifier=")));
});

test("start refuses an unconfigured provider", async (t) => {
  const h = await harness(t, { googleClientId: null, googleClientSecret: null });
  const res = await get(h.base, "/api/auth/oauth/google/start");
  assert.equal(res.status, 404);
});

test("start refuses OAuth entirely when no email domain is allowed", async (t) => {
  const h = await harness(t, { allowedEmailDomains: [] });
  const res = await get(h.base, "/api/auth/oauth/google/start");
  assert.equal(res.status, 503);
});

test("start rejects a non-loopback cli_redirect_uri before setting any cookie", async (t) => {
  const h = await harness(t);
  const res = await get(h.base, "/api/auth/oauth/github/start?cli_redirect_uri=http://evil.example/steal");
  assert.equal(res.status, 400);
  assert.equal(cookiePairs(res).length, 0);
});

test("dashboard flow: full round trip ends in a session cookie and populates /api/auth/me", async (t) => {
  const h = await harness(t);
  mockUpstream(t, {
    "https://oauth2.googleapis.com/token": { access_token: "fake-access-token" },
    "https://openidconnect.googleapis.com/v1/userinfo": { email: "ada@corp.test", email_verified: true },
  });

  const start = await get(h.base, "/api/auth/oauth/google/start");
  const cookies = cookiePairs(start);

  const callback = await get(h.base, `/api/auth/oauth/google/callback?code=abc&state=${extractState(start)}`, {
    cookies,
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/");
  const sessionCookie = cookiePairs(callback).find((c) => /fest_session=/.test(c));
  assert.ok(sessionCookie, "a dashboard session cookie was set");

  const me = await get(h.base, "/api/auth/me", { cookies: [sessionCookie!] });
  const meBody = (await me.json()) as {
    authenticated: boolean;
    user?: { email: string; role: string };
    setupRequired: boolean;
    oauthProviders: string[];
  };
  assert.equal(meBody.authenticated, true);
  assert.equal(meBody.user?.email, "ada@corp.test");
  assert.deepEqual(meBody.oauthProviders.sort(), ["github", "google"]);

  // The first person to complete a dashboard sign-in while nobody has
  // claimed this deployment claims it — the whole point of self-service
  // OAuth is that `fest admin create` is no longer the only way to get here.
  assert.equal(meBody.user?.role, "owner");
  assert.equal(meBody.setupRequired, false);
});

test("a pre-existing metering-only member (from a prior CLI token mint) still claims ownership on first dashboard sign-in", async (t) => {
  const h = await harness(t);
  mockUpstream(t, {
    "https://oauth2.googleapis.com/token": { access_token: "fake-access-token" },
    "https://openidconnect.googleapis.com/v1/userinfo": { email: "ada@corp.test", email_verified: true },
  });

  // Simulate `fest login` (or `fest token create`) having already created a
  // metering-only row for this email, before anyone ever claimed the
  // deployment via the dashboard. This is exactly the regression: an
  // `ensureUser` row with no console access must not block the bootstrap.
  const { ensureUser } = await import("../server/store/bootstrap.ts");
  ensureUser(h.store, { orgId: h.orgId, email: "ada@corp.test" });

  const start = await get(h.base, "/api/auth/oauth/google/start");
  const callback = await get(h.base, `/api/auth/oauth/google/callback?code=abc&state=${extractState(start)}`, {
    cookies: cookiePairs(start),
  });
  const sessionCookie = cookiePairs(callback).find((c) => /fest_session=/.test(c));
  assert.ok(sessionCookie);

  const me = await get(h.base, "/api/auth/me", { cookies: [sessionCookie!] });
  const meBody = (await me.json()) as { user?: { role: string }; setupRequired: boolean };
  assert.equal(meBody.user?.role, "owner");
  assert.equal(meBody.setupRequired, false);
});

test("once claimed, a second dashboard sign-in does not get promoted to owner", async (t) => {
  const h = await harness(t);
  mockUpstream(t, {
    "https://oauth2.googleapis.com/token": { access_token: "fake-access-token" },
    "https://openidconnect.googleapis.com/v1/userinfo": { email: "ada@corp.test", email_verified: true },
  });

  const first = await get(h.base, "/api/auth/oauth/google/start");
  await get(h.base, `/api/auth/oauth/google/callback?code=abc&state=${extractState(first)}`, {
    cookies: cookiePairs(first),
  });

  mockUpstream(t, {
    "https://oauth2.googleapis.com/token": { access_token: "fake-access-token-2" },
    "https://openidconnect.googleapis.com/v1/userinfo": { email: "bob@corp.test", email_verified: true },
  });
  const second = await get(h.base, "/api/auth/oauth/google/start");
  const callback = await get(h.base, `/api/auth/oauth/google/callback?code=xyz&state=${extractState(second)}`, {
    cookies: cookiePairs(second),
  });
  const sessionCookie = cookiePairs(callback).find((c) => /fest_session=/.test(c));

  const me = await get(h.base, "/api/auth/me", { cookies: [sessionCookie!] });
  const meBody = (await me.json()) as { user?: { email: string; role: string } };
  assert.equal(meBody.user?.email, "bob@corp.test");
  assert.equal(meBody.user?.role, "member");
});

test("CLI flow: callback mints an identity token and redirects to the loopback URL", async (t) => {
  const h = await harness(t);
  mockUpstream(t, {
    "https://github.com/login/oauth/access_token": { access_token: "fake-gh-token" },
    "https://api.github.com/user/emails": [{ email: "bob@corp.test", primary: true, verified: true }],
  });

  const start = await get(h.base, "/api/auth/oauth/github/start?cli_redirect_uri=http://127.0.0.1:9999/callback");
  const cookies = cookiePairs(start);
  assert.ok(cookies.some((c) => c.startsWith("fest_oauth_cli_redirect=")));

  const callback = await get(h.base, `/api/auth/oauth/github/callback?code=xyz&state=${extractState(start)}`, {
    cookies,
  });
  assert.equal(callback.status, 302);
  const location = new URL(callback.headers.get("location")!);
  assert.equal(location.origin + location.pathname, "http://127.0.0.1:9999/callback");
  const token = location.searchParams.get("token");
  assert.equal(location.searchParams.get("email"), "bob@corp.test");
  assert.ok(token && token.length > 0);

  const identity = await get(h.base, "/api/auth/identity", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(identity.status, 200);
  const identityBody = (await identity.json()) as { email: string };
  assert.equal(identityBody.email, "bob@corp.test");
});

test("an email outside the allow-list is denied and audited, never minted a token", async (t) => {
  const h = await harness(t);
  mockUpstream(t, {
    "https://oauth2.googleapis.com/token": { access_token: "fake-access-token" },
    "https://openidconnect.googleapis.com/v1/userinfo": { email: "outsider@other.test", email_verified: true },
  });

  const start = await get(h.base, "/api/auth/oauth/google/start");
  const callback = await get(h.base, `/api/auth/oauth/google/callback?code=abc&state=${extractState(start)}`, {
    cookies: cookiePairs(start),
  });
  assert.equal(callback.status, 302);
  assert.match(callback.headers.get("location") ?? "", /^\/\?auth_error=/);

  const rows = listAudit(h.store, h.orgId, {});
  const denied = rows.find((r) => r.action === "auth.oauth_login" && r.outcome === "denied");
  assert.ok(denied, "the rejection is recorded in the audit log");
  assert.equal(denied?.detail["reason"], "domain_not_allowed");
});

test("a mismatched state fails closed rather than trusting the callback", async (t) => {
  const h = await harness(t);
  const start = await get(h.base, "/api/auth/oauth/google/start");
  const callback = await get(h.base, "/api/auth/oauth/google/callback?code=abc&state=not-the-real-state", {
    cookies: cookiePairs(start),
  });
  assert.equal(callback.status, 302);
  assert.match(callback.headers.get("location") ?? "", /^\/\?auth_error=/);
});

test("/api/auth/identity rejects an unknown or revoked token", async (t) => {
  const h = await harness(t);
  const res = await get(h.base, "/api/auth/identity", { headers: { authorization: "Bearer not-a-real-token" } });
  assert.equal(res.status, 401);
});

function extractState(startResponse: Response): string {
  const cookie = cookiePairs(startResponse).find((c) => c.startsWith("fest_oauth_state="));
  assert.ok(cookie);
  return decodeURIComponent(cookie!.slice("fest_oauth_state=".length));
}
