# Fest

[![CI](https://github.com/cliftonc/fest-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/cliftonc/fest-gateway/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/fest-gateway.svg)](https://www.npmjs.com/package/fest-gateway)

A self-hosted gateway for Claude Code. Teams point their Claude Code at Fest the
way they'd point at Bedrock, so one place can monitor requests, tokens and cost —
and route to different models without Claude Code knowing the difference.

**The distinguishing goal: Claude Max / Team subscription support.** Each
developer authenticates with their *own* subscription. Fest relays that
credential and never stores it. Per-user pass-through, never pooling.

Three ways to read this, depending on what you want:

| | |
| --- | --- |
| [**Use it**](#use-it) | Someone runs a Fest; you want Claude Code going through it. |
| [**Run it**](#run-it) | You are standing one up for a team. |
| [**How it works**](#how-it-works) | What it can see, what it keeps, and what will bite you. |
| [**Develop it**](#develop-it) | Changing Fest itself. |

---

## Use it

Install the CLI. The package is `fest-gateway`; the command it installs is
`fest`, because plain `fest` was already taken on npm.

```bash
npm install -g fest-gateway
```

Sign in to your team's gateway, then start a session:

```bash
fest login --server https://fest.corp.test   # opens a browser, stores a token in ~/.fest
fest claude                                   # runs `claude`, environment set up for you
```

That's it. `fest claude` spawns the real `claude` binary with the environment
already pointed at the gateway, on **your own Anthropic subscription** — Fest
meters the usage and never sees your Anthropic credential at rest.

If your browser is already signed in to the dashboard, `fest login` is a single
approval click; otherwise it shows the gateway's login screen first.

Other commands:

```bash
fest whoami     # what's logged in, and whether the token is still live
fest logout     # forget the local token (does not revoke it server-side)
fest claude gw  # force org credentials + the gateway's extra models
```

Without installing anything, `npx fest-gateway login …` does the same job.

### If your operator hasn't set up OAuth

They can mint you a token by hand instead, and you point Claude Code at it
directly:

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  ANTHROPIC_BASE_URL=https://fest.corp.test/t/<token> claude
```

> **Never set `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` yourself.** Either
> one silently drops you off your own subscription onto whatever credential the
> server holds. `fest claude` clears them for you; the raw form above does it
> with `env -u`.

---

## Run it

### Getting started

An owner account must exist before Fest will serve on anything but loopback, so
that comes first:

```bash
docker compose run --rm fest admin create you@corp.test    # password shown once
docker compose up -d
```

Then either let developers self-serve with `fest login` (configure OAuth below),
or mint tokens for them:

```bash
docker compose run --rm fest token create dev@corp.test laptop   # shown once
```

Put Fest behind your own TLS proxy and set `FEST_SECURE_COOKIES=1` when you do:
the server only ever sees plain HTTP and cannot detect this for itself.

### Accounts

The dashboard needs a sign-in: scrypt passwords, an opaque session cookie hashed
at rest, an origin check on every mutating endpoint, and an audit log of
administrative actions. Accounts are granted from the host with `fest admin
create` — there is no self-registration and no email reset, because a gateway
should not need mail credentials to run.

Before anyone has run `fest admin create`, Fest serves the dashboard **open on
loopback and refuses to start on any other interface**. A single-developer trial
needs no setup, and "bound it to 0.0.0.0 and forgot the password" cannot happen
quietly.

```bash
docker compose run --rm fest admin create <email> [--role owner|admin|member]
docker compose run --rm fest admin list | admin passwd <email> | admin disable <email>
docker compose run --rm fest token list | token revoke <id>
```

### Configuration

| | |
| --- | --- |
| `FEST_PORT`, `FEST_HOST` | listen address. Default `127.0.0.1:8787`. |
| `FEST_DB`, `FEST_USAGE_LOG` | SQLite path, and the greppable JSONL trail. |
| `FEST_REQUIRE_IDENTITY` | refuse unattributed requests. Off by default; **on** for a team. |
| `FEST_SECURE_COOKIES` | set behind HTTPS. |
| `FEST_ROUTES` | routing table path. Absent means everything passes through. See [docs/ROUTING.md](docs/ROUTING.md). |
| `FEST_UPSTREAM_BASE_URL`, `FEST_LOG_LEVEL` | |
| `FEST_PRICING_REFRESH` | set `0` to never fetch prices. Rates then come only from the vendored snapshot, which is always sufficient. |
| `FEST_PRICING_URL` | internal mirror of litellm's price file. |
| `FEST_PUBLIC_URL` | base URL Fest is reachable at. Builds the OAuth redirect URI, and its path sets the mount point. Defaults to `http://<host>:<port>`. |
| `FEST_BASE_PATH` | mount path, if Fest is not at the root of its origin. Defaults to the path of `FEST_PUBLIC_URL`, so setting that is usually enough. |
| `FEST_GOOGLE_CLIENT_ID`, `FEST_GOOGLE_CLIENT_SECRET` | Google OAuth, for `fest login` and the dashboard. Absent means Google sign-in is off. |
| `FEST_GITHUB_CLIENT_ID`, `FEST_GITHUB_CLIENT_SECRET` | GitHub OAuth, same idea. |
| `FEST_ALLOWED_EMAIL_DOMAINS` | comma-separated. **Required to enable OAuth at all** — empty refuses every OAuth login rather than allowing any Google/GitHub account. |
| `FEST_DASHBOARD_URL` | **dev only.** Where the dashboard is when it isn't this server; `npm run dev` puts it on Vite's port. Leave unset in production. |

For the full OAuth setup, see [docs/CLI-AUTH.md](docs/CLI-AUTH.md).

### Behind a reverse proxy, on a path

Fest can be mounted under a path rather than on its own hostname. Set
`FEST_PUBLIC_URL` to the full URL including that path and Fest takes the mount
point from it: the dashboard's `<base href>` is rewritten to match, and the
OAuth redirect URI is built against it.

```caddyfile
fest.corp.test {
	handle_path /fest/* {
		reverse_proxy 127.0.0.1:8787 {
			# SSE: /api/live is a long-lived event stream, and a buffering
			# proxy turns the live screen into a screen that updates once.
			flush_interval -1
		}
	}
}
```

```bash
FEST_PUBLIC_URL=https://fest.corp.test/fest
FEST_SECURE_COOKIES=1
```

`handle_path` strips the `/fest` prefix before proxying. A plain `handle` +
`reverse_proxy`, which does not strip it, works too — Fest removes its own mount
path from an incoming request when it is still there, so either spelling routes.
Caddy passes the original `Host` upstream by default, which the CSRF origin
check needs; on nginx that is `proxy_set_header Host $host`, plus
`proxy_buffering off` for the event stream.

The registered OAuth redirect URI must include the path —
`https://fest.corp.test/fest/api/auth/oauth/google/callback`. Developers point
both Claude Code and the CLI at the full prefixed URL.

---

## How it works

### Why this is possible

Claude Code's inference client attaches the subscription OAuth bearer with **no
host check** against `ANTHROPIC_BASE_URL`. Point it at Fest while logged in with
Max/Team and Fest receives `Authorization: Bearer sk-ant-oat…`. Confirmed both by
reading the binary and by running it — see
[docs/PHASE0-RESULTS.md](docs/PHASE0-RESULTS.md).

Token refresh happens client-side against `api.anthropic.com`, outside
`ANTHROPIC_BASE_URL`. So Fest **forwards and forgets**: it never stores,
refreshes or holds a subscription credential. That is a genuine security
advantage over any "store the team's key" design, not a side effect.

### Two things that will bite you

**1. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` silently kill the
subscription.** Claude Code demotes off OAuth if *any* Anthropic-issued
credential is present — including an `apiKeyHelper`. So Fest's identity token
never goes in those variables; it rides in the URL path prefix or a custom
header. A design that ignores this moves a whole team off their subscriptions
onto a server-held key, invisibly.

**2. This is supported-by-absence, not by design.** There is no *documented*
path for relaying a subscription bearer through a third-party gateway. It works
because no guard exists. Treat it as a version-pinned dependency, and settle the
policy question with Anthropic before a team-wide rollout.

That dependency is enforced rather than remembered: `npm run canary` re-runs both
load-bearing Phase 0 experiments against the installed Claude Code release and
refuses the rollout if either has changed. See [docs/CANARY.md](docs/CANARY.md);
verdicts are recorded per version in `docs/canary-history.jsonl`.

Worth knowing: Anthropic ships its own self-hostable `claude gateway` with
central metering, pricing and managed policies. It authenticates via OIDC and
holds provider credentials itself, so it cannot do subscription pass-through —
but if that requirement ever softens, it is the supported product.

### What Fest can see, and what it keeps

This is a gateway every prompt a team writes passes through, so it is worth being
exact rather than reassuring.

**Fest sees everything, because it has to.** A request body arrives at this
process in full: prompts, file contents, tool results, the lot. That is
unavoidable for anything sitting on the wire.

**Fest keeps none of it.** Request bodies are relayed as opaque bytes and never
parsed for storage. What is written down is metadata: who, when, which model, how
many tokens in each of the four buckets, latency, HTTP status, error type, and
the session id Claude Code already sends. There is no column anywhere in the
schema for prompt or completion text — not disabled, *absent* — so "turn off
content capture" is not a setting that could be misconfigured.

**No credential is persistable, by construction rather than by policy.** A
subscription bearer is forwarded and forgotten; there is no table to put one in.
What is stored of a Fest identity token or a dashboard password is a hash. The
leak tests grep the entire database, every log line and every API response for
secret-shaped strings.

**An admin can see who used what, and when.** That is the point of a team
gateway, and developers pointing their editors at it should be told so plainly.
They cannot see each other: a `member` account sees only its own traffic,
enforced in the query layer rather than in the UI.

**Raw per-request rows age out after 30 days.** The hourly rollups, which are
aggregate, are kept for 400, so a year of trends does not require a year of
per-developer detail.

### Design commitments

- **Byte-for-byte pass-through.** Subscription tokens are validated against
  request shape, so the body is relayed as opaque bytes — never parsed and
  re-serialised. No model rewriting or prompt shaping on that path.
- **`cache_control` forwarded verbatim.** Stripping it silently destroys prompt
  caching and inflates every developer's token bill.
- **The four token buckets are disjoint.** `input_tokens` excludes cache reads
  and cache writes; context size is the sum. Folding cache reads into input is an
  order-of-magnitude error on a cache-heavy agent workload — and Claude Code is
  one.
- **`null` cost means unavailable, never zero.** A subscription request is real
  usage with *no org spend*; an unknown model is unpriced, not free. Totals
  therefore render honestly as `$12.3456 (+3 n/a)`. See
  [docs/PRICING.md](docs/PRICING.md).
- **For a subscription developer, quota is the scarce resource, not dollars.**
  Anthropic returns 5h/7d utilisation on every response, so that is what the
  dashboard shows rather than an invented dollar figure.

---

## Develop it

Node >= 22.18. There is **no build step for the server** — Node runs the
TypeScript directly via native type stripping. Only the dashboard is built, and
only the published npm package is compiled (Node refuses to strip types under
`node_modules`).

```bash
npm install
npm run dev        # gateway (node --watch) + dashboard (Vite, HMR), one terminal
npm test           # node --test
npm run typecheck  # tsc --noEmit, root then web/
npm run demo       # synthetic traffic in a scratch database, then dev
npm run canary     # version gate: re-run before rolling out a Claude Code release
```

Both `npm test` and `npm run typecheck` must be clean before committing. From a
clone the CLI runs straight off the TypeScript: `npm run cli -- login …` (note
the `--`).

### Layout

```
server/bin/fest.ts       CLI entrypoint: serve | migrate | token | admin | seed |
                                         login | whoami | claude | logout
server/pipeline/         passthrough (byte-for-byte) — the subscription path
server/http/             sse parser, tee, header discipline, errors, routing
server/store/            SQLite schema, write path, identity tokens
server/usage/            accumulator, pricing, nullable cost algebra
server/secret/           credential classification + redaction
server/auth/, server/api/  sessions, OAuth, the dashboard's JSON API
cli/                     the developer half of the CLI — no DB access, ever
shared/                  contracts both halves agree on, and the env vars that
                         silently kill subscription auth
web/                     the dashboard (Vite + React) — the only build step
tools/                   dev runner, canary, Phase 0 capture, price sync
test/                    node --test, flat
```

There is one `CLAUDE.md` per top-level folder with the conventions that apply
inside it — read the relevant one before working there.

### Docs

| | |
| --- | --- |
| [CLI-AUTH.md](docs/CLI-AUTH.md) | OAuth setup and the `fest login` flow end to end |
| [ROUTING.md](docs/ROUTING.md) | the routing table format and the substitute path |
| [PRICING.md](docs/PRICING.md) | where rates come from, and spend vs. value |
| [POSTURES.md](docs/POSTURES.md) | subscription vs. key posture |
| [CANARY.md](docs/CANARY.md) | the version-upgrade gate |
| [PHASE0.md](docs/PHASE0.md) · [PHASE0-RESULTS.md](docs/PHASE0-RESULTS.md) | the gating experiment, and what it found |
| [CLIENT-GATEWAY-PROTOCOL.md](docs/CLIENT-GATEWAY-PROTOCOL.md) | what Claude Code actually sends |
| [FRONTEND.md](docs/FRONTEND.md) | the dashboard's screens and data flow |

### Releasing

Bump `version` in `package.json`, then publish a GitHub Release tagged
`v<version>`. CI publishes to npm over trusted publishing (OIDC) — there is no
token in the repository — and refuses to publish if the tag and `package.json`
disagree.
