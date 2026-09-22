/**
 * `/api/auth/oauth/*`: Google/GitHub sign-in, and `/api/auth/identity`.
 *
 * A GET-only surface, unlike the rest of `/api/auth/*` — the whole flow is a
 * sequence of browser redirects, so there is no JSON body to receive and no
 * Origin header to check (the provider's redirect back is a cross-site
 * top-level navigation by definition, which is also why the state/verifier
 * cookies below are `SameSite=Lax`, not `Strict`: a Strict cookie would not
 * survive that navigation and every callback would fail state validation).
 *
 * One flow serves two callers, distinguished by whether `start` was called
 * with `cli_redirect_uri`:
 *   - dashboard: `start` -> provider -> `callback` -> session cookie -> `/`.
 *   - CLI (`fest login`): `start?cli_redirect_uri=http://127.0.0.1:<port>/callback`
 *     -> provider -> `callback` -> a freshly minted identity token -> redirect
 *     to the CLI's own loopback server, which is what captures it.
 *
 * `/api/auth/identity` is separate from both: it's how `fest whoami` asks
 * "is my token still good", authenticated the same way the proxy path is
 * (`Authorization: Bearer` or `X-Fest-Token`), not by cookie.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { generateState, generateCodeVerifier } from "arctic";
import type { Store } from "../store/db.ts";
import type { FestConfig } from "../config.ts";
import { googleProvider, githubProvider, emailDomainAllowed, isLoopbackRedirect } from "../auth/oauth.ts";
import type { OauthProvider } from "../auth/oauth.ts";
import { ensureUser } from "../store/bootstrap.ts";
import { normaliseEmail, hasAnyOwner } from "../auth/accounts.ts";
import { createSession, serializeCookie, parseCookies, ABSOLUTE_MS } from "../auth/session.ts";
import { createToken, resolveToken } from "../store/tokens.ts";
import { recordAudit } from "../store/audit.ts";
import { clientIp } from "../auth/guard.ts";
import { log } from "../log.ts";

export interface OauthDeps {
  readonly store: Store;
  readonly orgId: string;
  readonly config: FestConfig;
}

const STATE_COOKIE = "fest_oauth_state";
const VERIFIER_COOKIE = "fest_oauth_verifier";
const CLI_REDIRECT_COOKIE = "fest_oauth_cli_redirect";
const OAUTH_COOKIE_PATH = "/api/auth/oauth";
const OAUTH_COOKIE_MAX_AGE_S = 600;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * The narrow path these short-lived cookies are scoped to.
 *
 * It must be built from the mount point, not written as a constant: a cookie
 * scoped to `/api/auth/oauth` is not sent to `/fest/api/auth/oauth/…`, so the
 * state and verifier never come back and every sign-in fails the state check
 * as "invalid or expired" — with nothing wrong with the sign-in at all.
 */
function oauthCookiePath(basePath: string): string {
  return `${basePath}${OAUTH_COOKIE_PATH}`;
}

function oauthCookie(name: string, value: string, cfg: FestConfig): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${oauthCookiePath(cfg.basePath)}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${OAUTH_COOKIE_MAX_AGE_S}`,
  ];
  if (cfg.secureCookies) parts.push("Secure");
  return parts.join("; ");
}

function clearOauthCookie(name: string, cfg: FestConfig): string {
  const parts = [
    `${name}=`,
    `Path=${oauthCookiePath(cfg.basePath)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (cfg.secureCookies) parts.push("Secure");
  return parts.join("; ");
}

async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`google userinfo: HTTP ${res.status}`);
  const body = (await res.json()) as { email?: string; email_verified?: boolean };
  if (typeof body.email !== "string" || body.email_verified !== true) {
    throw new Error("google account has no verified email");
  }
  return body.email;
}

async function fetchGithubEmail(accessToken: string): Promise<string> {
  const res = await fetch("https://api.github.com/user/emails", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "user-agent": "fest",
      accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) throw new Error(`github emails: HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
  const primary = rows.find((r) => r.primary && r.verified);
  if (primary === undefined) throw new Error("github account has no verified primary email");
  return primary.email;
}

async function start(
  req: IncomingMessage,
  res: ServerResponse,
  provider: OauthProvider,
  deps: OauthDeps,
): Promise<void> {
  const cfg = deps.config;
  if (cfg.allowedEmailDomains.length === 0) {
    json(res, 503, { error: "OAuth sign-in is disabled: FEST_ALLOWED_EMAIL_DOMAINS is unset" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://internal");
  const cliRedirect = url.searchParams.get("cli_redirect_uri");
  if (cliRedirect !== null && !isLoopbackRedirect(cliRedirect)) {
    json(res, 400, { error: "cli_redirect_uri must be http://127.0.0.1 or http://localhost" });
    return;
  }

  const state = generateState();
  const cookies = [oauthCookie(STATE_COOKIE, state, cfg)];

  let authUrl: URL;
  if (provider === "google") {
    const built = googleProvider(cfg);
    if (built === null) {
      json(res, 404, { error: "google sign-in is not configured" });
      return;
    }
    const verifier = generateCodeVerifier();
    cookies.push(oauthCookie(VERIFIER_COOKIE, verifier, cfg));
    authUrl = built.createAuthorizationURL(state, verifier, ["openid", "profile", "email"]);
  } else {
    const built = githubProvider(cfg);
    if (built === null) {
      json(res, 404, { error: "github sign-in is not configured" });
      return;
    }
    authUrl = built.createAuthorizationURL(state, ["user:email"]);
  }

  if (cliRedirect !== null) cookies.push(oauthCookie(CLI_REDIRECT_COOKIE, cliRedirect, cfg));

  res.setHeader("set-cookie", cookies);
  res.writeHead(302, { location: authUrl.toString() });
  res.end();
}

async function callback(
  req: IncomingMessage,
  res: ServerResponse,
  provider: OauthProvider,
  deps: OauthDeps,
): Promise<void> {
  const cfg = deps.config;
  const cookies = parseCookies(req.headers.cookie);
  const cliRedirect = cookies[CLI_REDIRECT_COOKIE] ?? null;
  const clearCookies = [
    clearOauthCookie(STATE_COOKIE, cfg),
    clearOauthCookie(VERIFIER_COOKIE, cfg),
    clearOauthCookie(CLI_REDIRECT_COOKIE, cfg),
  ];

  const fail = (message: string): void => {
    res.setHeader("set-cookie", clearCookies);
    // The dashboard root as the browser sees it. A bare `/` drops the mount
    // path and lands the reader on whatever else is served at the origin root.
    const location =
      cliRedirect !== null
        ? `${cliRedirect}?error=${encodeURIComponent(message)}`
        : `${cfg.basePath}/?auth_error=${encodeURIComponent(message)}`;
    res.writeHead(302, { location });
    res.end();
  };

  const url = new URL(req.url ?? "/", "http://internal");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = cookies[STATE_COOKIE];

  if (code === null || state === null || expectedState === undefined || state !== expectedState) {
    fail("invalid or expired sign-in attempt");
    return;
  }

  let email: string;
  try {
    if (provider === "google") {
      const built = googleProvider(cfg);
      if (built === null) {
        fail("google sign-in is not configured");
        return;
      }
      const verifier = cookies[VERIFIER_COOKIE];
      if (verifier === undefined) {
        fail("invalid or expired sign-in attempt");
        return;
      }
      const tokens = await built.validateAuthorizationCode(code, verifier);
      email = await fetchGoogleEmail(tokens.accessToken());
    } else {
      const built = githubProvider(cfg);
      if (built === null) {
        fail("github sign-in is not configured");
        return;
      }
      const tokens = await built.validateAuthorizationCode(code);
      email = await fetchGithubEmail(tokens.accessToken());
    }
  } catch (err) {
    log.warn("oauth callback failed", { provider, error: String(err).slice(0, 200) });
    fail("sign-in failed");
    return;
  }

  const normalised = normaliseEmail(email);
  const ip = clientIp(req);

  if (!emailDomainAllowed(cfg, normalised)) {
    recordAudit(deps.store, {
      orgId: deps.orgId,
      actorLabel: normalised,
      action: "auth.oauth_login",
      outcome: "denied",
      detail: { provider, reason: "domain_not_allowed" },
      ip,
    });
    fail("this email domain is not permitted to sign in");
    return;
  }

  const user = ensureUser(deps.store, { orgId: deps.orgId, email: normalised });

  if (cliRedirect !== null) {
    const created = createToken(deps.store, { orgId: deps.orgId, userId: user.id, name: "cli-login" });
    recordAudit(deps.store, {
      orgId: deps.orgId,
      actorUserId: user.id,
      actorLabel: user.email,
      action: "auth.oauth_login",
      target: created.id,
      outcome: "ok",
      detail: { provider, mode: "cli" },
      ip,
    });
    res.setHeader("set-cookie", clearCookies);
    res.writeHead(302, {
      location: `${cliRedirect}?token=${encodeURIComponent(created.raw)}&email=${encodeURIComponent(user.email)}`,
    });
    res.end();
    return;
  }

  // Dashboard, not CLI: the first person to complete a sign-in while nobody
  // has claimed this deployment yet claims it, exactly as if they had run
  // `fest admin create` from the host — this OAuth path exists specifically
  // so that command is no longer the only way in. Never done on the CLI
  // token-minting branch above: a `fest login` should never be able to grant
  // dashboard ownership as a side effect.
  let owner = user;
  if (!hasAnyOwner(deps.store, deps.orgId)) {
    deps.store.db.prepare(`UPDATE users SET role = 'owner' WHERE id = ?`).run(user.id);
    owner = { ...user, role: "owner" };
  }

  const created = createSession(deps.store, {
    orgId: deps.orgId,
    userId: owner.id,
    userAgent: String(req.headers["user-agent"] ?? ""),
    ip,
  });
  recordAudit(deps.store, {
    orgId: deps.orgId,
    actorUserId: owner.id,
    actorLabel: owner.email,
    action: "auth.oauth_login",
    target: created.sessionId,
    outcome: "ok",
    detail: { provider, mode: "dashboard", role: owner.role },
    ip,
  });
  res.setHeader("set-cookie", [
    ...clearCookies,
    serializeCookie(created.raw, { secure: cfg.secureCookies, maxAgeSeconds: Math.floor(ABSOLUTE_MS / 1000) }),
  ]);
  // The dashboard root as the browser sees it, which is not `/` when Fest is
  // mounted under a path — redirecting there would leave the prefix behind.
  res.writeHead(302, { location: `${cfg.basePath}/` });
  res.end();
}

async function identity(req: IncomingMessage, res: ServerResponse, deps: OauthDeps): Promise<void> {
  if ((req.method ?? "GET") !== "GET") {
    json(res, 405, { error: "method not allowed" });
    return;
  }
  const auth = req.headers.authorization;
  const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const headerToken = req.headers["x-fest-token"];
  const raw = bearer ?? (typeof headerToken === "string" ? headerToken : null);

  const resolved = resolveToken(deps.store, raw);
  if (resolved === null) {
    json(res, 401, { error: "invalid or revoked token" });
    return;
  }

  const row = deps.store.db.prepare(`SELECT email FROM users WHERE id = ?`).get(resolved.userId) as
    | { email: string }
    | undefined;
  json(res, 200, { email: row?.email ?? "", orgId: resolved.orgId });
}

const ROUTE = /^\/api\/auth\/oauth\/(google|github)\/(start|callback)$/;

/** Handles `/api/auth/oauth/*` and `/api/auth/identity`. Returns false when the path is not ours. */
export async function handleOauth(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: OauthDeps,
): Promise<boolean> {
  if (path === "/api/auth/identity") {
    await identity(req, res, deps);
    return true;
  }

  const m = ROUTE.exec(path);
  if (m === null) return false;

  if ((req.method ?? "GET") !== "GET") {
    json(res, 405, { error: "method not allowed" });
    return true;
  }

  const provider = m[1] as OauthProvider;
  const step = m[2] as "start" | "callback";
  if (step === "start") {
    await start(req, res, provider, deps);
  } else {
    await callback(req, res, provider, deps);
  }
  return true;
}
