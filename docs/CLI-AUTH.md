# OAuth login, and the developer half of the CLI

This is the self-service alternative to an operator running `fest token create
<email>` for every developer: sign in with Google or GitHub, and `fest login`
walks away with an identity token it can use on your behalf.

## Enabling it, as an operator

Set whichever provider(s) you want, plus the allow-list — **OAuth is off by
default**, and stays off until `FEST_ALLOWED_EMAIL_DOMAINS` is set. An empty
allow-list is not "allow everyone"; it is "refuse every OAuth login". This
matters because a self-minted identity token can spend server-held credentials
on the substitute path (Fireworks, say), so "nobody configured this" must fail
closed.

```
FEST_GOOGLE_CLIENT_ID=...
FEST_GOOGLE_CLIENT_SECRET=...
FEST_GITHUB_CLIENT_ID=...
FEST_GITHUB_CLIENT_SECRET=...
FEST_ALLOWED_EMAIL_DOMAINS=corp.test          # comma-separated
FEST_PUBLIC_URL=https://fest.corp.test        # defaults to http://<host>:<port>
```

Register OAuth apps with each provider using these redirect URIs:

```
{FEST_PUBLIC_URL}/api/auth/oauth/google/callback
{FEST_PUBLIC_URL}/api/auth/oauth/github/callback
```

You can configure one provider, both, or neither — an unconfigured provider's
routes 404 rather than erroring at boot, the same way an unconfigured routing
upstream behaves (Phase 4). Password sign-in (`fest admin create`) keeps
working regardless; OAuth is additive.

## A dev-mode gotcha: use `127.0.0.1`, not `localhost`

`npm run dev` serves the dashboard from Vite on `:5173`, proxying `/api` to the
gateway on `:8787` (`FEST_PUBLIC_URL` defaults to `http://127.0.0.1:8787`, the
gateway's own bind address). Browse it at **`http://127.0.0.1:5173`**, not
`http://localhost:5173`.

Cookies are scoped by hostname string, not by resolved address — `localhost`
and `127.0.0.1` are different cookie domains even though they're the same
machine. The OAuth `state` cookie is set while `/start` is reached through the
Vite proxy (on whatever host you browsed from), but the provider's redirect
back lands on the gateway's own origin directly, bypassing Vite. If those two
legs disagree on hostname, the state cookie never arrives at the callback and
you'll see `invalid or expired sign-in attempt` — followed by success on a
retry launched from the gateway's own origin, which is consistent, not
flaky: the mismatch was the bug. Same-hostname-different-port is fine, since
cookies aren't port-scoped; same-address-different-hostname is not.

## `fest login`, end to end

This is a loopback-redirect flow, not a device code you type back in — nothing
is ever copy-pasted between the browser and the terminal.

**`--server` must be the gateway's own address** — the same one you'd hand to
`ANTHROPIC_BASE_URL` by hand — never a dashboard dev server. In `npm run dev`
that's the *gateway* line it prints (`http://127.0.0.1:8787`), not the
*dashboard* line (`http://127.0.0.1:5173`): Vite only proxies `/api/*`, so a
`fest claude` pointed at the dashboard port will mint fine, look logged in,
and then fail every actual request with a confusing "issue with the selected
model" from inside Claude Code. `fest login` checks `GET {server}/healthz`
before doing anything else specifically to catch this — if you see "does not
look like a Fest gateway," this is almost certainly why.

1. `fest login --server https://fest.corp.test [--provider google|github]`
   starts a temporary HTTP server on `127.0.0.1` (a small port range,
   `8865`-`8875`) and opens your browser at
   `{server}/api/auth/oauth/{provider}/start?cli_redirect_uri=http://127.0.0.1:<port>/callback`.
2. The server runs normal OAuth against Google/GitHub (via
   [arctic](https://www.npmjs.com/package/arctic)), with `state` (and, for
   Google, a PKCE `code_verifier`) held in short-lived cookies — never a
   database row.
3. On success, the server checks `FEST_ALLOWED_EMAIL_DOMAINS`, finds-or-creates
   a `users` row for the verified email (`ensureUser`, the same idempotent
   lookup `fest token create` uses), mints a fresh identity token
   (`createToken` — same function, no admin-only gate on it), and redirects
   the browser to your loopback server with `?token=...&email=...`.
4. Your CLI's temporary server captures it, shows a static "you can close this
   window" page, and shuts itself down.
5. The token is written to `~/.fest/config.json` (mode `0600`, inside
   `~/.fest/`, mode `0700`) — never echoed to the terminal, since it's already
   on disk.

The **same two routes** serve the dashboard's "Continue with Google/GitHub"
buttons — call `/start` with no `cli_redirect_uri` and you get a session
cookie and a redirect to `/` instead of a minted token. One flow, two callers,
distinguished by whether that query param was present.

## `~/.fest/config.json`

```json
{
  "serverUrl": "https://fest.corp.test",
  "identityToken": "fest_...",
  "email": "ada@corp.test",
  "provider": "google"
}
```

`FEST_TOKEN` + `FEST_SERVER_URL` override this file when both are set — the CI
path, where writing to a shared runner's home directory would be the wrong
kind of persistence.

## The other three commands

- **`fest whoami`** — prints what's stored locally, then calls
  `GET /api/auth/identity` (authenticated the same way the proxy path is:
  `Authorization: Bearer` or `X-Fest-Token`, not a cookie) to confirm the token
  hasn't been revoked.
- **`fest claude [-- claude-args...]`** — requires a prior login, sets
  `ANTHROPIC_BASE_URL=<serverUrl>/t/<identityToken>`, strips every var in
  `shared/demotion-vars.ts` from the child environment (the same list
  `tools/canary.ts` clears for its own test client, and for the identical
  reason — an inherited `ANTHROPIC_API_KEY` silently demotes Claude Code off
  your subscription), then `spawn("claude", ...)`.
- **`fest logout`** — deletes `~/.fest/config.json` only. It does **not**
  revoke the token server-side; that stays an explicit `fest token revoke
  <id>`, an operator action against the database. Logout here means "forget
  this on my machine," not a security control.
