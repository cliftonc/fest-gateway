/**
 * Who may call the dashboard API.
 *
 * This guards `/api/*` only. The proxy path (`/v1/*`) authenticates completely
 * differently — an identity token presented by a developer's Claude Code — and
 * must never require a browser session. Conflating them would mean a developer
 * has to log in to a web page before their editor works.
 *
 * ── The unclaimed state ──────────────────────────────────────────────────────
 *
 * Before anyone has run `fest admin create`, there is no account to sign in
 * with. Rather than ship a well-known default password, Fest serves the
 * dashboard open *only while bound to loopback*, and refuses to serve it at all
 * on any other interface. So the single-developer trial still works with no
 * setup, and the failure mode "I bound it to 0.0.0.0 and forgot to add a
 * password" cannot happen quietly — it cannot happen at all.
 */

import type { IncomingMessage } from "node:http";
import type { Store } from "../store/db.ts";
import type { Session } from "./session.ts";
import { parseCookies, cookieName, resolveSession } from "./session.ts";
import { hasAnyOwner } from "./accounts.ts";

export type AccessDecision =
  | { readonly allow: true; readonly session: Session | null; readonly unclaimed: boolean }
  | { readonly allow: false; readonly status: 401 | 403 | 503; readonly error: string };

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.trim().toLowerCase());
}

export function sessionFromRequest(
  store: Store,
  req: IncomingMessage,
  secureCookies: boolean,
): Session | null {
  const cookies = parseCookies(req.headers.cookie);
  return resolveSession(store, cookies[cookieName(secureCookies)] ?? null);
}

export interface GuardDeps {
  readonly store: Store;
  readonly orgId: string;
  readonly bindHost: string;
  readonly secureCookies: boolean;
}

/** Decide whether this `/api/*` request may proceed. */
export function authorizeApi(req: IncomingMessage, deps: GuardDeps): AccessDecision {
  const session = sessionFromRequest(deps.store, req, deps.secureCookies);
  if (session !== null) return { allow: true, session, unclaimed: false };

  if (!hasAnyOwner(deps.store, deps.orgId)) {
    if (isLoopbackHost(deps.bindHost)) return { allow: true, session: null, unclaimed: true };
    return {
      allow: false,
      status: 503,
      error:
        "Fest has no owner account yet, and refuses to serve an unauthenticated dashboard " +
        "off loopback. Run: fest admin create <email>",
    };
  }

  return { allow: false, status: 401, error: "authentication required" };
}

/**
 * Cross-site request forgery, handled by origin rather than by token.
 *
 * A double-submit token would add a second secret to manage for no gain here:
 * the session cookie is already `SameSite=Strict`, so a browser will not attach
 * it to a cross-site request at all, and this is the belt to that's braces. A
 * form POSTed from another origin cannot control `Origin`.
 *
 * A missing `Origin` is rejected rather than waved through. Browsers always
 * send it on POST; the only callers it inconveniences are scripts, which can
 * set it, and that is the right way round — waving it through would restore the
 * exact hole this closes for any browser that omits it.
 */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== "string" || origin === "" || typeof host !== "string") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Best-effort client address, for the audit trail only — never for access. */
export function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "";
}
