/**
 * `fest login`: the loopback OAuth flow.
 *
 * Opens the server's OAuth start URL in the developer's browser with a
 * `cli_redirect_uri` pointing at a temporary local server on 127.0.0.1. The
 * server, after completing Google/GitHub OAuth, redirects the browser back
 * here with a freshly minted identity token in the query string — see
 * `server/api/oauth.ts` and docs/CLI-AUTH.md. This is a loopback-redirect
 * flow, not device-code polling: nothing is ever typed back into the CLI.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import open from "open";
import { writeCliConfig } from "./config.ts";

const PORT_RANGE_START = 8865;
const PORT_RANGE_END = 8875;
const TIMEOUT_MS = 5 * 60_000;

function escapeHtml(s: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => map[c]!);
}

const SUCCESS_HTML =
  "<!doctype html><title>fest login</title>" +
  '<body style="font-family:sans-serif">Signed in. You can close this window and return to your terminal.</body>';

function errorHtml(message: string): string {
  return (
    "<!doctype html><title>fest login</title>" +
    `<body style="font-family:sans-serif">Sign-in failed: ${escapeHtml(message)}</body>`
  );
}

type CallbackHandler = (req: IncomingMessage, res: ServerResponse) => void;

async function listenOnFreePort(handler: CallbackHandler): Promise<{ server: Server; port: number }> {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port += 1) {
    const server = createServer(handler);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      });
      return { server, port };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`no free port in ${PORT_RANGE_START}-${PORT_RANGE_END} for the login callback`);
}

type CallbackResult = { token: string; email: string } | { error: string };

/**
 * `--server` must be the GATEWAY's own address — the same one you'd hand to
 * `ANTHROPIC_BASE_URL` by hand — not the Vite dashboard dev server. The two
 * are easy to confuse (`npm run dev` prints both, and the dashboard is the
 * one you actually open in a browser), but Vite only proxies `/api/*`, not
 * `/v1/messages`, so a `fest claude` pointed at the dashboard port fails
 * downstream inside Claude Code with a confusing "issue with the selected
 * model" rather than here, where the mistake is actually legible. Caught
 * before ever opening a browser, not after minting a token that then quietly
 * doesn't work.
 */
async function checkIsGateway(serverUrl: string): Promise<void> {
  let ok = false;
  try {
    const res = await fetch(`${serverUrl}/healthz`);
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    ok = res.ok && body?.ok === true;
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(
      `${serverUrl} does not look like a Fest gateway (GET /healthz failed).\n` +
        "Use the gateway's own address — the same one you'd set ANTHROPIC_BASE_URL\n" +
        "to by hand — not a dashboard dev server. `npm run dev` prints both; the\n" +
        "one you want here is the \"gateway\" line, not the \"dashboard\" line.",
    );
  }
}

export async function runLogin(opts: {
  provider: "google" | "github";
  serverUrl: string;
  /** Injected so tests can run the whole flow without launching a real browser. */
  openBrowser?: (url: string) => Promise<unknown>;
}): Promise<void> {
  const serverUrl = opts.serverUrl.replace(/\/+$/, "");
  await checkIsGateway(serverUrl);

  let resolveResult!: (v: CallbackResult) => void;
  const done = new Promise<CallbackResult>((resolve) => {
    resolveResult = resolve;
  });

  const { server, port } = await listenOnFreePort((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const token = url.searchParams.get("token");
    const email = url.searchParams.get("email");
    const error = url.searchParams.get("error");
    if (error !== null) {
      res.writeHead(200, { "content-type": "text/html" }).end(errorHtml(error));
      resolveResult({ error });
      return;
    }
    if (token === null || email === null) {
      res.writeHead(400, { "content-type": "text/html" }).end(errorHtml("missing token"));
      resolveResult({ error: "callback did not include a token" });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(SUCCESS_HTML);
    resolveResult({ token, email });
  });

  try {
    const callbackUrl = `http://127.0.0.1:${port}/callback`;
    const startUrl = `${serverUrl}/api/auth/oauth/${opts.provider}/start?cli_redirect_uri=${encodeURIComponent(callbackUrl)}`;

    process.stdout.write(`Opening your browser to sign in with ${opts.provider}...\n`);
    process.stdout.write(`If it doesn't open, visit:\n  ${startUrl}\n`);
    (opts.openBrowser ?? open)(startUrl).catch(() => {});

    const timeout = new Promise<CallbackResult>((resolve) => {
      const t = setTimeout(() => resolve({ error: "timed out waiting for sign-in" }), TIMEOUT_MS);
      t.unref();
    });

    const result = await Promise.race([done, timeout]);
    if ("error" in result) throw new Error(`login failed: ${result.error}`);

    await writeCliConfig({
      serverUrl,
      identityToken: result.token,
      email: result.email,
      provider: opts.provider,
    });
    // The token is already written to disk; echoing it here would only add it
    // to shell scrollback for no benefit, unlike `fest token create`, which is
    // designed to be copied by hand into an env var.
    process.stdout.write(`Logged in as ${result.email} via ${opts.provider}.\n`);
    process.stdout.write("Token stored in ~/.fest/config.json (mode 600).\n");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
