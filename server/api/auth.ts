/**
 * Sign in, sign out, and "who am I".
 *
 * These are the only mutating endpoints Fest exposes over HTTP, so this file
 * also owns the rules that apply to mutation: the origin check, the login
 * throttle, and the audit entries.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../store/db.ts";
import { authenticate, hasAnyOwner, normaliseEmail } from "../auth/accounts.ts";
import {
  createSession,
  revokeSession,
  serializeCookie,
  clearedCookie,
  ABSOLUTE_MS,
} from "../auth/session.ts";
import type { Session } from "../auth/session.ts";
import { originAllowed, clientIp, sessionFromRequest } from "../auth/guard.ts";
import { recordAudit } from "../store/audit.ts";
import { log } from "../log.ts";
import type { MeResponse } from "../../shared/api.ts";
import type { FestConfig } from "../config.ts";
import { handleOauth } from "./oauth.ts";
import { configuredProviders } from "../auth/oauth.ts";

const MAX_BODY_BYTES = 4 * 1024;

export interface AuthDeps {
  readonly store: Store;
  readonly orgId: string;
  readonly secureCookies: boolean;
  readonly config: FestConfig;
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify(body));
}

/**
 * Login throttle, in memory and per (email, ip).
 *
 * In memory because Fest is one process per deployment, and putting this in
 * SQLite would let an unauthenticated caller drive writes into the same
 * single-writer database the metering flush needs. The trade is that a restart
 * clears the counters — acceptable against online guessing, which is what this
 * defends; offline guessing is scrypt's job.
 */
const ATTEMPT_WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; first: number }>();

function throttled(key: string, now: number): boolean {
  const entry = attempts.get(key);
  if (entry === undefined) return false;
  if (now - entry.first > ATTEMPT_WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function noteFailure(key: string, now: number): void {
  const entry = attempts.get(key);
  if (entry === undefined || now - entry.first > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, first: now });
    return;
  }
  entry.count += 1;
  // Unbounded growth is a memory DoS from unauthenticated input.
  if (attempts.size > 10_000) attempts.clear();
}

export function clearLoginThrottle(): void {
  attempts.clear();
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Handle `/api/auth/*`. Returns false when the path is not ours.
 *
 * `session` is passed in rather than re-resolved so there is exactly one place
 * a cookie is turned into an identity per request.
 */
export async function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: AuthDeps,
  session: Session | null,
): Promise<boolean> {
  if (!path.startsWith("/api/auth/")) return false;
  const method = req.method ?? "GET";

  // OAuth is a redirect-driven, GET-only surface, and Bearer/X-Fest-Token
  // authenticated on /api/auth/identity — neither fits the POST + Origin +
  // cookie-session shape the rest of this file enforces, so it's handled
  // entirely separately.
  if (await handleOauth(req, res, path, { store: deps.store, orgId: deps.orgId, config: deps.config })) {
    return true;
  }

  if (path === "/api/auth/me" && method === "GET") {
    json(res, 200, {
      // Not 401: "am I signed in" is a question an anonymous caller is allowed
      // to ask, and answering it with an error makes the login page's first
      // render look like a failure.
      authenticated: session !== null,
      ...(session === null
        ? {}
        : { user: { id: session.userId, email: session.email, role: session.role } }),
      // The dashboard shows a setup banner rather than a login form when
      // nobody has claimed this deployment yet.
      setupRequired: !hasAnyOwner(deps.store, deps.orgId),
      oauthProviders: configuredProviders(deps.config),
    } satisfies MeResponse);
    return true;
  }

  if (method !== "POST") {
    json(res, 405, { error: "method not allowed" });
    return true;
  }
  if (!originAllowed(req)) {
    json(res, 403, { error: "cross-origin request refused" });
    return true;
  }

  if (path === "/api/auth/login") {
    await handleLogin(req, res, deps);
    return true;
  }

  if (path === "/api/auth/logout") {
    if (session !== null) {
      revokeSession(deps.store, session.sessionId);
      recordAudit(deps.store, {
        orgId: deps.orgId,
        actorUserId: session.userId,
        actorLabel: session.email,
        action: "auth.logout",
        outcome: "ok",
        ip: clientIp(req),
      });
    }
    // Cleared unconditionally: a request with a stale cookie should come back
    // without one, whether or not the session was still live.
    json(res, 200, { ok: true }, { "set-cookie": clearedCookie(deps.secureCookies) });
    return true;
  }

  json(res, 404, { error: `no such endpoint: ${path}` });
  return true;
}

async function handleLogin(req: IncomingMessage, res: ServerResponse, deps: AuthDeps): Promise<void> {
  const body = await readJsonBody(req);
  if (body === null) {
    json(res, 400, { error: "expected a small JSON body" });
    return;
  }

  const email = normaliseEmail(str(body["email"]));
  const password = str(body["password"]);
  const ip = clientIp(req);
  const now = Date.now();
  const key = `${email}|${ip}`;

  if (email === "" || password === "") {
    json(res, 400, { error: "email and password are required" });
    return;
  }

  if (throttled(key, now)) {
    recordAudit(deps.store, {
      orgId: deps.orgId,
      actorLabel: email,
      action: "auth.login",
      outcome: "denied",
      detail: { reason: "throttled" },
      ip,
    });
    // 429 and not 401: a caller being rate-limited needs to know that retrying
    // with better credentials will not help until the window passes.
    json(res, 429, { error: "too many attempts; try again later" });
    return;
  }

  const outcome = await authenticate(deps.store, deps.orgId, email, password);
  if (!outcome.ok || outcome.user === null) {
    noteFailure(key, now);
    // The reason is recorded for the operator and withheld from the client:
    // "no such account" vs "wrong password" is an account enumeration oracle.
    recordAudit(deps.store, {
      orgId: deps.orgId,
      actorLabel: email,
      action: "auth.login",
      outcome: "denied",
      detail: { reason: outcome.reason },
      ip,
    });
    log.warn("login failed", { email, reason: outcome.reason, ip });
    json(res, 401, { error: "invalid email or password" });
    return;
  }

  attempts.delete(key);
  const created = createSession(deps.store, {
    orgId: deps.orgId,
    userId: outcome.user.id,
    userAgent: String(req.headers["user-agent"] ?? ""),
    ip,
  });

  recordAudit(deps.store, {
    orgId: deps.orgId,
    actorUserId: outcome.user.id,
    actorLabel: outcome.user.email,
    action: "auth.login",
    target: created.sessionId,
    outcome: "ok",
    ip,
  });

  json(
    res,
    200,
    {
      authenticated: true,
      user: { id: outcome.user.id, email: outcome.user.email, role: outcome.user.role },
      setupRequired: false,
      oauthProviders: configuredProviders(deps.config),
    } satisfies MeResponse,
    {
      "set-cookie": serializeCookie(created.raw, {
        secure: deps.secureCookies,
        maxAgeSeconds: Math.floor(ABSOLUTE_MS / 1000),
      }),
    },
  );
}
