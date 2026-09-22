/**
 * `/api/auth/cli/*`: signing the CLI in from a browser session you already have.
 *
 * `fest login` used to go straight to `/api/auth/oauth/<provider>/start`, which
 * redirects to Google unconditionally — even when the browser it just opened
 * already holds a valid Fest session. The CLI cannot know that (it has no
 * access to browser cookies), but the server can, because the browser sends the
 * session cookie with the request.
 *
 * So the CLI now opens `authorize`, and this module decides:
 *   - session present -> an approval page, one click, no provider round trip.
 *   - no session      -> hand straight back to the OAuth flow, unchanged.
 *
 * ## Why there is a button at all
 *
 * Minting an identity token from nothing but an ambient cookie, on a GET, is
 * CSRF-shaped: any page could navigate a signed-in developer to
 * `…/api/auth/cli/authorize?cli_redirect_uri=http://127.0.0.1:8865/callback`
 * and, with something listening on their loopback, take a live token in
 * silence. The approval step is what makes that impossible without a visible,
 * deliberate action — and the POST behind it is origin-checked, so the click
 * cannot be forged from another origin either.
 *
 * The page is server-rendered rather than a dashboard screen. It has to work
 * before the SPA bundle is built, it must survive the sign-in redirect that a
 * hash-routed SPA would lose its query string across, and the token it is
 * approving should not depend on a megabyte of JavaScript having loaded.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../store/db.ts";
import type { FestConfig } from "../config.ts";
import type { Session } from "../auth/session.ts";
import { configuredProviders, isLoopbackRedirect } from "../auth/oauth.ts";
import { originAllowed, clientIp } from "../auth/guard.ts";
import { createToken } from "../store/tokens.ts";
import { recordAudit } from "../store/audit.ts";

export interface CliAuthDeps {
  readonly store: Store;
  readonly orgId: string;
  readonly config: FestConfig;
}

const AUTHORIZE_PATH = "/api/auth/cli/authorize";
const APPROVE_PATH = "/api/auth/cli/approve";

function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string): void {
  const buf = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(buf.byteLength),
    // A page that mints credentials must never be held in a cache or a
    // back-forward buffer where a later visitor could re-submit it.
    "cache-control": "no-store",
    // `same-origin`, NOT `no-referrer`. Under a no-referrer policy a browser
    // sends `Origin: null` on a form submission, and the origin check on
    // `approve` — the thing standing between an ambient cookie and a minted
    // token — then refuses this page's own button with "cross-origin request
    // refused". `same-origin` still sends nothing to the loopback callback,
    // which is the only cross-origin hop here.
    "referrer-policy": "same-origin",
  });
  res.end(buf);
}

/**
 * Self-contained styling: no bundle, no fonts, no network. The palette tracks
 * the dashboard's own tokens, including its dark default, so this does not look
 * like a different product at the one moment trust matters most.
 */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Fest</title>
<style>
  :root {
    color-scheme: dark light;
    --bg: #0d1117; --card: #161b22; --fg: #e6edf3; --muted: #8b949e;
    --line: #30363d; --accent: #a371f7; --accent-fg: #ffffff; --ok: #3fb950;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f8fa; --card: #ffffff; --fg: #1f2328; --muted: #59636e;
      --line: #d1d9e0; --accent: #8250df; --accent-fg: #ffffff; --ok: #1a7f37;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: var(--bg); color: var(--fg);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    width: 100%; max-width: 460px; background: var(--card);
    border: 1px solid var(--line); border-radius: 14px; padding: 28px;
    box-shadow: 0 12px 34px rgb(0 0 0 / 0.22);
  }
  .brand { font-size: 17px; font-weight: 700; letter-spacing: 0.02em; margin: 0 0 20px; }
  h1 { font-size: 19px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0 0 14px; color: var(--muted); font-size: 13.5px; }
  .who {
    display: block; margin: 0 0 16px; padding: 11px 13px; border-radius: 9px;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 34%, transparent);
    color: var(--fg); font-weight: 600; font-size: 14px; word-break: break-all;
  }
  .target {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; color: var(--muted); word-break: break-all;
  }
  .row { display: flex; gap: 10px; margin-top: 20px; }
  button, .btn {
    flex: 1; display: inline-flex; align-items: center; justify-content: center;
    padding: 10px 16px; border-radius: 9px; font: inherit; font-size: 14px;
    font-weight: 600; cursor: pointer; text-decoration: none; border: 1px solid var(--line);
    background: transparent; color: var(--fg);
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  button.primary:hover { filter: brightness(1.1); }
  .btn:hover { border-color: var(--muted); }
  .foot { margin: 18px 0 0; font-size: 12px; color: var(--muted); }
  a { color: var(--accent); }
</style>
</head>
<body><main class="card"><div class="brand">Fest</div>${body}</main></body>
</html>`;
}

/** `http://127.0.0.1:8865/callback` -> `127.0.0.1:8865`, for showing a human. */
function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}

function approvalPage(cfg: FestConfig, session: Session, cliRedirect: string): string {
  const action = `${cfg.basePath}${APPROVE_PATH}?cli_redirect_uri=${encodeURIComponent(cliRedirect)}`;
  return page(
    "Authorise the Fest CLI",
    `<h1>Authorise the Fest CLI?</h1>
     <p>A command line on this machine is asking to sign in as:</p>
     <strong class="who">${escapeHtml(session.email)}</strong>
     <p>
       It will receive an identity token that attributes your Claude Code usage to you.
       Your Anthropic credential is never involved, and Fest never stores one.
     </p>
     <p class="target">Token will be delivered to ${escapeHtml(hostOf(cliRedirect))}</p>
     <form method="post" action="${escapeHtml(action)}">
       <div class="row">
         <a class="btn" href="${escapeHtml(cliRedirect)}?error=${encodeURIComponent("cancelled")}">Cancel</a>
         <button class="primary" type="submit">Authorise</button>
       </div>
     </form>
     <p class="foot">
       If you did not just run <code>fest login</code>, cancel — something else asked for this.
     </p>`,
  );
}

/**
 * Returns false when the path is not ours, so the caller can carry on. `session`
 * is whatever the guard already resolved — null when there is none, which is a
 * normal case here rather than an error.
 */
export async function handleCliAuth(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: CliAuthDeps,
  session: Session | null,
): Promise<boolean> {
  if (path !== AUTHORIZE_PATH && path !== APPROVE_PATH) return false;

  const cfg = deps.config;
  const url = new URL(req.url ?? "/", "http://internal");
  const cliRedirect = url.searchParams.get("cli_redirect_uri");

  // Checked before anything else on both routes: this value decides where a
  // live credential is delivered.
  if (cliRedirect === null || !isLoopbackRedirect(cliRedirect)) {
    json(res, 400, { error: "cli_redirect_uri must be http://127.0.0.1 or http://localhost" });
    return true;
  }

  const method = req.method ?? "GET";

  if (path === AUTHORIZE_PATH) {
    if (method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return true;
    }

    if (session === null) {
      // The dashboard's own login screen, rather than a second sign-in UI
      // rendered here or a jump straight to a provider. It already handles
      // password and OAuth, the unclaimed-deployment banner, and whichever
      // providers are actually configured — all of which would otherwise have
      // to be duplicated and kept in step. It carries the CLI's callback
      // through and comes back here once there is a session.
      //
      // `dashboardUrl` is normally null and this is simply our own root. It is
      // set under `npm run dev`, where the dashboard is Vite on another port
      // and this server has no login screen worth showing.
      const dashboard = cfg.dashboardUrl ?? cfg.basePath;
      res.writeHead(302, {
        location: `${dashboard}/?cli_authorize=${encodeURIComponent(cliRedirect)}`,
        "cache-control": "no-store",
      });
      res.end();
      return true;
    }

    html(res, 200, approvalPage(cfg, session, cliRedirect));
    return true;
  }

  // APPROVE_PATH: the deliberate action. Everything below is the reason the
  // approval page exists at all, so none of it may be relaxed for convenience.
  if (method !== "POST") {
    json(res, 405, { error: "method not allowed" });
    return true;
  }
  if (!originAllowed(req)) {
    json(res, 403, { error: "cross-origin request refused" });
    return true;
  }
  if (session === null) {
    json(res, 401, { error: "authentication required" });
    return true;
  }

  const created = createToken(deps.store, {
    orgId: deps.orgId,
    userId: session.userId,
    name: "cli-login",
  });
  recordAudit(deps.store, {
    orgId: deps.orgId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "auth.cli_authorize",
    target: created.id,
    outcome: "ok",
    // Recorded because it is the answer to "where did that token go".
    detail: { mode: "cli", via: "session", redirectHost: hostOf(cliRedirect) },
    ip: clientIp(req),
  });

  res.writeHead(302, {
    location: `${cliRedirect}?token=${encodeURIComponent(created.raw)}&email=${encodeURIComponent(session.email)}`,
    "cache-control": "no-store",
  });
  res.end();
  return true;
}
