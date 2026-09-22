# The two postures

A developer reaches Fest in one of two ways, and the choice is consequential
rather than cosmetic. Fest **detects** which one from the request — it is never
configured, because it is a property of the developer's own environment.

|  | Subscription | Key |
| --- | --- | --- |
| Set | `ANTHROPIC_BASE_URL=<fest>/t/<token>` | `ANTHROPIC_AUTH_TOKEN=<token>` |
| Who pays for Anthropic models | the developer's own Max/Team plan | the org |
| Body forwarding | byte-for-byte verbatim | rewriting allowed |
| Model menu in `/model` | ✗ not possible | ✓ published by Fest |
| Recorded as | `inbound_subscription` | `fallback_server` |

**These are mutually exclusive by construction, not by policy.** Setting
`ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`, or an `apiKeyHelper`) is exactly
what makes Claude Code abandon subscription auth. In 2.1.278 a server-published
model menu and subscription pass-through cannot both exist. Do not design around
having both.

Prefer the subscription posture where you can: it bills each developer's own
plan, keeps their usage under their own rate limits, and means Fest never holds
a credential that can spend org money.

## A Fest token is identity wherever it arrives

Path prefix, `X-Fest-Token`, or `Authorization: Bearer fest_…` — in all three it
is identity, and it is **never forwarded upstream**. Relaying our own bearer
would authenticate nothing at Anthropic and would disclose a credential that can
impersonate that developer on this gateway.

Precedence is path → `X-Fest-Token` → auth header. The auth header is last
because it is the only position a token lands in by accident.

## Key posture needs somewhere for requests to go

With `ANTHROPIC_AUTH_TOKEN` set there is no caller credential to relay, so every
request must be served on a server-held credential. A model with nowhere to go
gets an explicit 401 that says *this is a server configuration problem, not a
problem with your token* — otherwise the developer spends the afternoon
re-checking the one thing that is not wrong.

**An `anthropic` upstream is the standing answer for the rest.** Define one in
`routes.json` and every Anthropic model that no route claims is served there on
the org's own key, id unchanged — a credential substitution, not a model one.
Opus and Haiku stop being a cliff without one exact-match route per model id,
which is config that has to be updated every time Anthropic ships a model and
fails as a first-message 401 when someone forgets.

Three limits, because this is the direction that spends money:

- **It never applies in the subscription posture.** That path has a caller
  credential; diverting it would bill the org for a turn the developer's own
  plan had already covered. The fallback is reached only where the inbound
  credential is absent — which is why it lives in `dispatch.ts` rather than
  being expressible as a `claude-*` wildcard in the file. `resolveRoute` is
  posture-blind, so such a wildcard would capture subscription traffic too.
- **It never overrides a route**, including an `upstream: null` carve-out.
- **It never routes a non-Anthropic id**, so `gpt-oss-120b` still fails with
  Fest's message rather than a 404 from a vendor who never had that model.

Records from this path carry `pipeline: "substitute"` with `routeId: null`:
substituted, but not by a route anyone wrote.

## `GET /v1/models`

**The client only asks if you tell it to.** Discovery is gated on four things,
all of which must hold:

1. `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` set **on the client**
2. `ANTHROPIC_BASE_URL` set to a non-first-party host
3. `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` **not** set
4. a credential in `ANTHROPIC_AUTH_TOKEN` / `apiKeyHelper` / API key

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
ANTHROPIC_AUTH_TOKEN=<your-fest-token> \
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 \
claude
```

**`fest claude gw` is the supported way to get here.** It sets (2) and (4) from
your `~/.fest` login, refuses to spawn if the gateway has nothing servable, and
warns about any base model you could select that has no route — see
`docs/CLI-AUTH.md`. You still export (1) yourself, since it governs the client
rather than the gateway. `fest claude` with no `gw` picks this posture on its
own if you have no Anthropic subscription login.

Without (1) the client never calls the endpoint at all — confirmed empirically
(zero requests) and in the binary (`[Bootstrap] Skipped gateway /v1/models
(CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY not set)`). The menu is cached at
`~/.claude/cache/gateway-models.json`; delete it if you change routes and the
picker looks stale.

Claude Code fetches `{base}/v1/models?limit=1000` with a 3-second timeout and
renders the result under `/model` labelled "From gateway", caching it to
`<cache>/gateway-models.json` (0600). Fest answers from already-parsed config —
no network, no database.

Three things this gets right, each of which took running it to find:

- **Ids are filtered client-side by `/(claude|anthropic)/i`.** Publishing
  `accounts/fireworks/models/kimi-k2p7-code` would make the entry *vanish*, not
  appear. So the menu publishes the id a developer actually types.
- **Wildcard routes still show up.** A pattern like `claude-sonnet-*` cannot be
  an id, so the first version produced a menu showing no substitutions at all —
  the common case, silently invisible. Concrete ids are now resolved through
  `resolveRoute`, the same function the request path uses, so the label and the
  routing decision cannot disagree.
- **Substituted models are labelled with their destination** — `Sonnet 5 →
  fireworks`. A developer choosing "Sonnet 5" and silently getting Kimi is the
  substitution this project exists to prevent, and the model picker is the first
  place they would not notice.
- **The menu offers only what Fest can actually serve.** The first version
  published Anthropic's built-ins unconditionally "so routing never loses Opus".
  That was backwards: discovery only happens in the key posture, where there is
  no caller credential to fall back on, so an unrouted id is a guaranteed
  failure the moment it is selected — seen in use as `Opus 5 — From gateway`
  returning a 401. A menu is a promise; it may only promise what it can keep.
  With nothing servable, Fest returns `404` and the client falls back to its own
  built-in list, which is the documented behaviour.
- **Entries are deduped against the client's built-in list**, so publishing
  `claude-sonnet-5` collides with the built-in Sonnet and is dropped silently.
  A route's `expose` alias (e.g. `claude-sonnet-5-kimi`) exists to survive that:
  a distinct id appears in the picker, labelled with its destination, and routes
  to the same place. Verified in 2.1.278: gateway options are merged only
  `if(!s.some((he)=>uT(he,U)))`.

## Errors are UI, and the client retries them

Two constraints, both learned by watching real failures render:

- **The message is truncated** to roughly one line. The first sentence must
  carry the whole actionable point; anything after it may never be read.
- **The client retries.** Its predicate is `x-should-retry` first, then
  408/409/429/5xx, plus a token-refresh path on 401. A permanent configuration
  problem returned as 401 produced ten escalating retries — `Retrying in 8s ·
  attempt 5/10` — of a request that could never succeed. So "no credential
  configured for this model" is a **400** with `x-should-retry: false`, and
  every auth failure here carries an explicit `retryable` flag.

Note the model is still told it is Claude: Claude Code's system prompt says
"You are a Claude agent" and lists Claude model ids. (The "You are powered by
the model named X" line is injected **server-side by Anthropic**, so a
substituted model never receives it — verified by capturing the real 27KB system
prompt.) A substituted model will therefore misreport its own identity if asked.

## `POST /v1/messages/count_tokens`

Relayed, deliberately **not** metered: it consumes no tokens, and counting it
would inflate request counts and drag every per-request average toward zero. It
is relayed rather than estimated locally because only the provider knows its own
tokenizer, and a wrong number feeds Claude Code's context accounting — causing
either premature compaction or an overflow at the worst moment.
