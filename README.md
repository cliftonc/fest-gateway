# Fest

A self-hosted gateway for Claude Code. Teams point their Claude Code at Fest the
way they'd point at Bedrock, so one place can monitor requests, tokens and cost —
and route to different models without Claude Code knowing the difference.

**The distinguishing goal: Claude Max / Team subscription support.** Each
developer authenticates with their *own* subscription. Fest relays their own
credential and never stores it. Per-user pass-through, never pooling.

> **Status: feature complete for a team trial.** A real Claude Code session on a
> Max subscription runs through Fest, is attributed to its developer, metered
> into SQLite, and shown on a dashboard behind a login. Model routing and
> substitution work and are visible. Phase 0 cleared both gates
> ([results](docs/PHASE0-RESULTS.md)), and `npm run canary` re-checks them
> against each new Claude Code release.

```bash
docker compose run --rm fest admin create you@corp.test    # password shown once
docker compose up -d
docker compose run --rm fest token create dev@corp.test laptop   # shown once
```

Each developer then points Claude Code at the printed URL:

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  ANTHROPIC_BASE_URL=http://fest.corp:8787/t/<token> claude
```

Or, if the operator has configured Google/GitHub OAuth (see below), a developer
can skip all of that and self-serve a token from their own machine:

```bash
npx fest login --server http://fest.corp:8787   # opens a browser, stores a token in ~/.fest
npx fest claude                                  # runs `claude`, env set up for you
npx fest whoami                                  # what's logged in, and whether it's still live
```

`npx fest ...` works straight from a clone of this repo — no global install and
nothing published to a registry. `npm run cli -- ...` (note the `--`) is the
same thing via npm scripts, if that's the more natural habit; `npm link` once
if you want a bare `fest` on your PATH instead.

Or without Docker:

```bash
node server/bin/fest.ts admin create you@corp.test
node server/bin/fest.ts token create dev@corp.test laptop
FEST_REQUIRE_IDENTITY=1 node server/bin/fest.ts serve
```

## Why this is possible

Claude Code's inference client attaches the subscription OAuth bearer with **no
host check** against `ANTHROPIC_BASE_URL`. Point it at Fest while logged in with
Max/Team and Fest receives `Authorization: Bearer sk-ant-oat…`. Confirmed both
by reading the binary and by running it — see
[docs/PHASE0-RESULTS.md](docs/PHASE0-RESULTS.md).

Token refresh happens client-side against `api.anthropic.com`, outside
`ANTHROPIC_BASE_URL`. So Fest **forwards and forgets**: it never stores,
refreshes or holds a subscription credential. That is a genuine security
advantage over any "store the team's key" design, not just a side effect.

## Two things that will bite you

**1. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` silently kill the
subscription.** Claude Code demotes off OAuth if *any* Anthropic-issued
credential is present — including an `apiKeyHelper`. So Fest's identity token
never goes in those variables; it rides in the URL path prefix or a custom
header. A design that ignores this silently moves a whole team off their
subscriptions onto a server-held key, and the failure is invisible.

**2. This is supported-by-absence, not by design.** There is no *documented*
path for relaying a subscription bearer through a third-party gateway. It works
because no guard exists. Treat it as a version-pinned dependency, and settle the
policy question with Anthropic before a team-wide rollout.

The version dependency is enforced rather than remembered: `npm run canary`
re-runs both load-bearing Phase 0 experiments against the installed release and
refuses the rollout if either has changed. See [docs/CANARY.md](docs/CANARY.md);
verdicts are recorded per version in `docs/canary-history.jsonl`.

Worth knowing: Anthropic ships its own self-hostable `claude gateway` (see
`claude gateway --help`) with central metering, pricing and managed policies. It
authenticates via OIDC and holds provider credentials itself, so it cannot do
subscription pass-through — but if that requirement ever softens, it is the
supported product.

## Design commitments

- **Byte-for-byte pass-through.** Subscription tokens are validated against
  request shape, so the body is relayed as opaque bytes — never parsed and
  re-serialised. No model rewriting or prompt shaping on that path.
- **`cache_control` forwarded verbatim.** Stripping it silently destroys prompt
  caching and inflates every developer's token bill.
- **Metadata only.** Token counts, models, latency, status — never prompt or
  completion content.
- **No credential is persistable.** Not by policy, by construction: there is no
  store to put one in. Only fingerprints, enforced by tests.

## Layout

```
server/bin/fest.ts       CLI: serve | migrate | token | admin | seed |
                              login | whoami | claude | logout
server/pipeline/         passthrough (byte-for-byte) — the subscription path
server/http/             sse parser, tee, header discipline, errors, routing
server/store/            SQLite schema, write path, identity tokens
server/usage/            accumulator, lean pricing, nullable cost algebra
server/secret/           credential classification + redaction
server/auth/oauth.ts     Google/GitHub provider construction
server/api/oauth.ts      /api/auth/oauth/* and /api/auth/identity
cli/                     the developer half of the CLI — no DB access, ever.
                         login (loopback OAuth flow) | whoami | claude | logout,
                         and the ~/.fest config they share
shared/types.ts          the contracts both halves agree on
shared/demotion-vars.ts  env vars that silently kill subscription auth
tools/capture-server.ts  Phase 0 diagnostic (throwaway)
docs/PHASE0.md           the gating experiment runbook
docs/CLI-AUTH.md         OAuth setup and the fest login/whoami/claude flow
test/                    node --test
```

## Accounting rules that are easy to get wrong

- **The four token buckets are disjoint.** `input_tokens` excludes cache reads
  and cache writes; context size is the sum. Folding cache reads into input is
  an order-of-magnitude error on a cache-heavy agent workload — and Claude Code
  is one (a trivial `-p` call here showed ~16k cache reads and ~12k one-hour
  cache writes).
- **`null` cost means unavailable, never zero.** A subscription request is real
  usage with *no org spend*; an unknown model is unpriced, not free. Rollups
  therefore carry a priced sum plus `unpriced_requests` and
  `subscription_requests` separately, so a total renders honestly as
  `$12.3456 (+3 n/a)`.
- **For a subscription developer, quota is the scarce resource, not dollars.**
  Anthropic returns 5h/7d utilisation on every response, so that is what the
  dashboard shows rather than an invented dollar figure.

## What Fest can see, and what it keeps

This is a gateway every prompt a team writes passes through, so it is worth
being exact about what that means rather than reassuring.

**Fest sees everything, because it has to.** A request body arrives at this
process in full: prompts, file contents you asked Claude about, tool results,
the lot. That is unavoidable for anything sitting on the wire, and no wording
changes it.

**Fest keeps none of it.** Request bodies are relayed as opaque bytes and never
parsed for storage. What is written down is metadata: who, when, which model,
how many tokens in each of the four buckets, latency, HTTP status, error type,
and the session id Claude Code already sends. There is no column anywhere in
the schema for prompt or completion text — not disabled, absent — so "turn off
content capture" is not a setting that could be misconfigured.

**No credential is persistable, by construction rather than by policy.** A
subscription bearer is forwarded and forgotten; there is no table to put one in.
What is stored of a Fest identity token or a dashboard password is a hash. The
leak tests grep the entire database, every log line and every API response for
secret-shaped strings.

**Raw per-request rows age out after 30 days**; the hourly rollups, which are
aggregate, are kept for 400 so a year of trends does not require a year of
per-developer detail.

**An admin can see who used what, and when.** That is the point of a team
gateway, and the developers pointing their editors at it should be told so
plainly. They cannot see each other: a `member` account sees only its own
traffic, enforced in the query layer rather than in the UI.

## Deploying it

`docker compose up -d` after creating an owner account. The image has no runtime
dependencies — Node runs the TypeScript directly — so it is Node plus this
repository.

The dashboard needs a sign-in: scrypt passwords, an opaque session cookie
hashed at rest, an origin check on the two endpoints that mutate anything, and
an audit log of administrative actions. Accounts are granted from the host with
`fest admin create`; there is no self-registration and no email reset, because a
gateway should not need mail credentials to run.

Before anyone has run `fest admin create`, Fest serves the dashboard **open on
loopback and refuses to start on any other interface**. A single-developer trial
needs no setup, and "bound it to 0.0.0.0 and forgot the password" cannot happen
quietly.

Put it behind your own TLS proxy and set `FEST_SECURE_COOKIES=1` when you do:
the server only ever sees plain HTTP and cannot detect this for itself.

| | |
| --- | --- |
| `FEST_PORT`, `FEST_HOST` | listen address. Default `127.0.0.1:8787`. |
| `FEST_DB`, `FEST_USAGE_LOG` | SQLite path, and the greppable JSONL trail. |
| `FEST_REQUIRE_IDENTITY` | refuse unattributed requests. Off by default; **on** for a team. |
| `FEST_SECURE_COOKIES` | set behind HTTPS. |
| `FEST_ROUTES` | routing table path. Absent means everything passes through. |
| `FEST_UPSTREAM_BASE_URL`, `FEST_LOG_LEVEL` | |
| `FEST_GOOGLE_CLIENT_ID`, `FEST_GOOGLE_CLIENT_SECRET` | Google OAuth, for `fest login` and the dashboard. Absent means Google sign-in is off. |
| `FEST_GITHUB_CLIENT_ID`, `FEST_GITHUB_CLIENT_SECRET` | GitHub OAuth, same idea. |
| `FEST_ALLOWED_EMAIL_DOMAINS` | comma-separated. **Required to enable OAuth at all** — empty refuses every OAuth login rather than allowing any Google/GitHub account. |
| `FEST_PUBLIC_URL` | base URL Fest is reachable at, for building the OAuth redirect URI. Defaults to `http://<host>:<port>`. |

See [docs/CLI-AUTH.md](docs/CLI-AUTH.md) for the full OAuth setup and how
`fest login`'s loopback flow works.

## Requirements

Node >= 22.18 (TypeScript runs directly via native type stripping — no build
step for the server). Vite + React are used only for the dashboard, later.

## Commands

```bash
npm test          # node --test
npm run canary    # version gate: re-run before rolling out a Claude Code release
npm run capture   # Phase 0 capture server
npm run typecheck # tsc --noEmit (needs npm install first)
npm run dev       # gateway + dashboard with hot reload
npm run demo      # synthetic traffic in a scratch database, then both of the above
```

```bash
node server/bin/fest.ts admin create <email> [--role R] [--password-stdin]
node server/bin/fest.ts admin list | admin passwd <email> | admin disable <email>
node server/bin/fest.ts token create <email> [name] | token list | token revoke <id>
```
