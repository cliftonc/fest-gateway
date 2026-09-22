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
   `{server}/api/auth/cli/authorize?cli_redirect_uri=http://127.0.0.1:<port>/callback`.
2. **If that browser already has a Fest session**, the gateway shows an
   approval page naming the account and the loopback address the token will be
   delivered to. One click and you are done — no provider round trip, because
   you have already proved who you are to this gateway. The CLI cannot know
   this in advance (it has no access to browser cookies); the gateway can,
   because the browser sends the session cookie with that request.

   The click is not decoration. Minting a token from nothing but an ambient
   cookie, on a GET, would let any page navigate a signed-in developer to that
   URL and — with something listening on their loopback — take a live token in
   silence. `approve` is a POST and is origin-checked, so it cannot be forged.

   For the same reason the page must never set a `no-referrer` policy:
   browsers null the `Origin` header on form submissions under it, and the
   origin check then refuses the page's own button.
3. **If there is no session**, the gateway redirects to the dashboard's own
   login screen with `?cli_authorize=<callback>`. It parks that in
   `sessionStorage` (the query string does not survive an OAuth round trip)
   and, once signed in, hands back to `authorize` for the approval step.
   Under `npm run dev` the dashboard is Vite on another port, so
   `FEST_DASHBOARD_URL` tells the gateway where to send it; `tools/dev.mjs`
   sets that for you.
4. Signing in from that screen runs normal OAuth against Google/GitHub (via
   [arctic](https://www.npmjs.com/package/arctic)), with `state` (and, for
   Google, a PKCE `code_verifier`) held in short-lived cookies — never a
   database row.
5. On success, the server checks `FEST_ALLOWED_EMAIL_DOMAINS`, finds-or-creates
   a `users` row for the verified email (`ensureUser`, the same idempotent
   lookup `fest token create` uses), mints a fresh identity token
   (`createToken` — same function, no admin-only gate on it), and redirects
   the browser to your loopback server with `?token=...&email=...`.
6. Your CLI's temporary server captures it, shows a static "you can close this
   window" page, and shuts itself down.
7. The token is written to `~/.fest/config.json` (mode `0600`, inside
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
- **`fest claude [gw] [-- claude-args...]`** — requires a prior login, then
  spawns the real `claude` binary in one of two **postures**. Both strip every
  var in `shared/demotion-vars.ts` from the child environment first (the same
  list `tools/canary.ts` clears for its own test client, and for the identical
  reason — an inherited `ANTHROPIC_API_KEY` silently demotes Claude Code off
  your subscription).

  | | subscription posture | gateway posture |
  | --- | --- | --- |
  | `ANTHROPIC_BASE_URL` | `<serverUrl>/t/<identityToken>` | `<serverUrl>` |
  | `ANTHROPIC_AUTH_TOKEN` | unset | `<identityToken>` |
  | who pays | **your own Anthropic plan** | **org credentials** |
  | `/model` menu | Claude Code's built-ins only | built-ins **+ "From gateway"** |

  **The posture is auto-detected.** `~/.claude.json` has an `oauthAccount` →
  subscription posture. It does not → gateway posture, because a subscription
  posture with no subscription behind it cannot work. `fest claude gw` forces
  gateway posture when you want the gateway menu anyway. There is deliberately
  no `sub` counterpart: the only case auto-detect sends to gateway is "you have
  no subscription login", and forcing subscription there could not work. `gw` is
  only recognised *before* `--`, so `fest claude -- gw` still forwards it to the
  child.

  Fest prints one line to stderr saying which posture it chose and **who pays**,
  every time — auto-detection means that is now something Fest asserts rather
  than something you typed.

  Two things are specific to gateway posture:

  - The gateway menu still needs
    **`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`** exported on your side —
    without it Claude Code never calls `/v1/models` at all. Fest reminds you if
    it is unset.
  - **Every model you select needs a substitute route.** There is no caller
    credential to fall back on, so an unrouted model 401s on the first message.
    `fest claude gw` preflights `GET /v1/models` (3s; a network error is only a
    warning) and, before spawning, either hard-errors on a `--model` /
    `ANTHROPIC_MODEL` / settings `model` that is unrouted, or — when it cannot
    see which model the session will open on — warns about any of Anthropic's
    base models the gateway cannot serve. A gateway publishing nothing at all is
    a hard error naming `FEST_ROUTES`.

  In subscription posture Fest also scans `~/.claude/settings{,.local}.json` and
  `./.claude/settings{,.local}.json` for `apiKeyHelper` or an
  `env.ANTHROPIC_API_KEY` / `env.ANTHROPIC_AUTH_TOKEN`, **by key only**, and
  warns loudly if it finds one. No env manipulation can clear those — the client
  reads its own settings files — so without the warning you would believe you
  were on your own plan while the session was billed elsewhere.
- **`fest logout`** — deletes `~/.fest/config.json` only. It does **not**
  revoke the token server-side; that stays an explicit `fest token revoke
  <id>`, an operator action against the database. Logout here means "forget
  this on my machine," not a security control.
