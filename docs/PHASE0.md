# Phase 0 — the gate

Fest's primary requirement is **Claude Max / Team subscription pass-through**:
each developer authenticates with their own subscription, Fest relays their own
credential, and nobody pools a subscription.

Static analysis of Claude Code 2.1.278 says this works — the inference client
attaches the subscription OAuth bearer with **no host check** against
`ANTHROPIC_BASE_URL`. But "the client sends it" is not "the product works".
Anthropic still has to *accept* a relayed bearer.

**Run these before writing any Fest server code.** Outcome decides the product.

## Safety

The capture server never records a credential value. Each is reduced to a kind
label (`ANTHROPIC_OAUTH_SUBSCRIPTION` vs `ANTHROPIC_API_KEY`), an 11-char prefix,
and a sha256 fingerprint. Bodies are reduced to a shape summary with prompt text
capped at 200 chars. Verified by a leak check in `test/`.

`MODE=forward` does send your real credential to the real Anthropic API — it has
to, that is the experiment. It relays bytes verbatim and stores nothing.

## Preflight: clear the demotion triggers

Any of these silently demotes Claude Code off your subscription onto key auth,
which would invalidate every run:

```bash
env | grep -E '^ANTHROPIC_|^CLAUDE_CODE_' || echo "no relevant env vars set"
```

Also check every settings layer for `apiKeyHelper`, `ANTHROPIC_API_KEY` or
`ANTHROPIC_AUTH_TOKEN` (inspect these yourself; they may contain secrets):

- `~/.claude/settings.json`
- `~/.claude/settings.local.json`
- `.claude/settings.json` in the working directory
- any managed/enterprise policy file

Confirm you are on a Max/Team login, not an API key, before starting.

## The runs

Start the server in one terminal, run `claude` in another.

### (a) Does the subscription bearer arrive?

```bash
LOG=capture-a.jsonl node tools/capture-server.ts
```

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8899 \
  claude -p hi
```

**Expect** `credentialKinds: ["ANTHROPIC_OAUTH_SUBSCRIPTION"]` and
`anthropic_beta` containing `oauth-2025-04-20`.
If you instead see `ANTHROPIC_API_KEY`, the static reading is wrong for this
build — stop and reassess.

### (b) Confirm the footgun

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8899 ANTHROPIC_API_KEY=dummy-not-a-real-key \
  claude -p hi
```

**Expect** the OAuth bearer to **vanish**, replaced by the dummy key. This proves
Fest must never put its identity token in `ANTHROPIC_API_KEY` /
`ANTHROPIC_AUTH_TOKEN`.

### (c) Custom header rides alongside

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8899 \
  ANTHROPIC_CUSTOM_HEADERS="X-Fest-Token: fest_testtoken123" \
  claude -p hi
```

**Expect** both credentials recorded, kinds
`["ANTHROPIC_OAUTH_SUBSCRIPTION", "FEST_IDENTITY_TOKEN"]`. The bearer must be
unaffected.

### (d) Path-prefix identity survives

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8899/t/fest_testtoken123 \
  claude -p hi
```

**Expect** `url: "/t/fest_testtoken123/v1/messages"` and
`identityFromPath.remainder: "/v1/messages"`. If the prefix is dropped or
replaces the path, fall back to carrier (c).

### (e) THE ONE THAT MATTERS — does Anthropic accept a relayed bearer?

```bash
MODE=forward LOG=capture-e.jsonl node tools/capture-server.ts
```

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8899 \
  claude -p "say hello in five words"
```

**Expect** `upstream.status: 200`, a real streamed reply in the terminal, and
`timing.ttfbMs` recorded. A `401`/`403` means Anthropic validates more than the
bearer — check `upstream.errorEventSeen`, then see "If (e) fails" below.

### (f) cache_control must survive

Inspect the `(a)` records: `body.system_cache_control` should contain
`"ephemeral"` on a warm session. Fest must forward this verbatim; a proxy that
strips it silently destroys prompt caching and inflates everyone's bill. Claude
Code has a watchdog that warns `[cache-coverage] … the endpoint may be silently
stripping cache_control` — if you see that while running through Fest later, this
is the cause.

### (g) Token refresh stays client-side

Leave a `(e)`-mode session idle past token expiry (~1h), then prompt again.

**Expect** the request to succeed, and the capture log to show a **different**
`fingerprint` on the bearer, with no refresh traffic through the capture server.
This confirms Fest never needs to store or refresh a subscription credential.

## Reading the results

```bash
# Which credential family arrived on each request
python3 -c "import json,sys;[print(json.loads(l)['id'], json.loads(l)['credentialKinds'], json.loads(l).get('upstream',{}).get('status','-')) for l in open('capture-a.jsonl')]"
```

## Decision rule

| Result | Action |
| --- | --- |
| (a) sends bearer, (e) accepted | Subscription pass-through is viable. Build Phase 1. |
| (a) sends bearer, (e) rejected | Re-run (e) with a *completely* untouched pipeline first (no `accept-encoding` override). If still rejected, subscription pass-through is dead: fall back to API-key / Bedrock / Vertex. |
| (a) does not send bearer | Try `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`. If that unlocks it, record a fragile dependency on a private env var. If not, key posture only. |

## If (e) fails

Localise what Anthropic validates by re-running (e) while changing exactly one
thing: strip `anthropic-beta`, rewrite `user-agent`, or alter one byte of the
leading system prompt. That tells you whether acceptance is bound to request
shape, client identity, or the beta flag.

## Caveat worth repeating

There is no *documented* path for relaying a subscription bearer through a
third-party gateway. This works because no guard exists, not because it is a
supported feature. Re-run (a) and (e) against every new Claude Code release
before rolling it to a team — the failure mode is silent demotion of everyone
onto a server-held key.

That re-run is automated: `npm run canary`, documented in [CANARY.md](CANARY.md),
with the verdict for each version recorded in `canary-history.jsonl`. The runs
below stay here because a red canary is localised by hand, one change at a time.

---

## Running Fest itself (post-Phase 2)

```bash
node server/bin/fest.ts migrate
node server/bin/fest.ts token create you@corp.test laptop   # shown once
FEST_REQUIRE_IDENTITY=1 node server/bin/fest.ts serve
```

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8787/t/<token> claude
```

`FEST_REQUIRE_IDENTITY=1` is what a team deployment wants: without it,
unattributed requests are served and recorded with a null `user_id`, which
defeats the point of a shared gateway. It defaults to off only so a
single-developer trial works with no setup.

Env: `FEST_PORT`, `FEST_HOST`, `FEST_DB`, `FEST_USAGE_LOG`,
`FEST_UPSTREAM_BASE_URL`, `FEST_LOG_LEVEL`, `FEST_REQUIRE_IDENTITY`.
