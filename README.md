# Fest

A self-hosted gateway for Claude Code. Teams point their Claude Code at Fest the
way they'd point at Bedrock, so one place can monitor requests, tokens and cost —
and route to different models without Claude Code knowing the difference.

**The distinguishing goal: Claude Max / Team subscription support.** Each
developer authenticates with their *own* subscription. Fest relays their own
credential and never stores it. Per-user pass-through, never pooling.

> **Status: Phase 1 working.** A real Claude Code session on a Max subscription
> runs through Fest and is metered. Phase 0 cleared both gates
> ([results](docs/PHASE0-RESULTS.md)). Next: SQLite store, then the dashboard.

```bash
node server/bin/fest.ts

env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8787/t/<your-token> claude
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
because no guard exists. Treat it as a version-pinned dependency, keep the
canary test running against every Claude Code release, and settle the policy
question with Anthropic before a team-wide rollout.

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
tools/capture-server.ts   Phase 0 diagnostic (throwaway)
server/secret/            credential classification + redaction
docs/PHASE0.md            the gating experiment runbook
test/                     node --test
```

## Requirements

Node >= 22.18 (TypeScript runs directly via native type stripping — no build
step for the server). Vite + React are used only for the dashboard, later.

## Commands

```bash
npm test          # node --test
npm run capture   # Phase 0 capture server
npm run typecheck # tsc --noEmit (needs npm install first)
```
