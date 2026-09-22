# Routing and substitution (Phase 4)

Fest can serve some models from a provider other than the caller's own Claude
subscription, using a credential the **server** holds. That is org spend and a
different vendor seeing the traffic, so the design goal is not "make routing
possible" — it is **make every substitution impossible to miss**.

## Default: nothing is routed

With no `FEST_ROUTES` set, Fest can only relay a request to Anthropic on the
caller's own credential. Substitution requires an operator to have written a
file saying so. This is the safe default and it is not configurable away by
accident: a routing file that fails to parse **stops the process** rather than
degrading to "no routing", because degrading would silently push substituted
traffic back onto developers' subscriptions.

## Config

```jsonc
{
  "upstreams": {
    "fireworks": {
      "adapter": "fireworks",
      "baseUrl": "https://api.fireworks.ai/inference",
      // A REFERENCE, never a literal. The value stays out of config and out of
      // the database; everything recorded says "env:FIREWORKS_API_KEY".
      "credential": "{env:FIREWORKS_API_KEY}"
    }
  },
  "routes": [
    // Exceptions can appear anywhere — exact beats wildcard regardless of order.
    { "id": "keep-opus", "match": "claude-opus-5", "upstream": null },
    { "id": "oss",       "match": "gpt-oss-*",
      "upstream": "fireworks", "model": "accounts/fireworks/models/gpt-oss-120b" }
  ]
}
```

## The one exception: an `anthropic` upstream is a default

An upstream on the `anthropic` adapter is Anthropic's own API on a key the
*server* holds. Defining one makes it the destination for every Anthropic model
no route claims — but **only for requests with no caller credential**, i.e. the
key posture, where pass-through cannot serve anything at all and the alternative
is a first-message 401.

```jsonc
{
  "upstreams": {
    "anthropic": {
      "adapter": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      // NOT named ANTHROPIC_API_KEY: that name belongs in a developer's shell,
      // where it silently demotes them off their own subscription.
      "credential": "{env:ANTHROPIC_ORG_API_KEY}"
    }
  },
  "routes": []
}
```

That is the whole config — no route per model id, and an `anthropic` upstream is
exempt from the "nothing routes here" validation error for that reason. It is
identified by *adapter*, not by the id an operator typed, because the adapter is
what makes it a safe default.

It does not weaken the section above. A subscription-posture request still
passes through on its own credential (`resolveRoute` is posture-blind and this
fallback is not reachable from there — see `resolveWithoutCallerCredential`), an
explicit route still wins, an `upstream: null` carve-out is still honoured, and a
non-Anthropic id is still never sent to Anthropic. What it changes is only the
case that had no good outcome: org-key traffic for a model nobody mapped.

## Where the keys go

In a `.env` file in the repo root. `npm start`, `npm run dev` and `npm run demo`
load it through Node's own `--env-file-if-exists=.env` — no `dotenv`
dependency, and no failure when the file is absent.

```sh
cp .env.example .env
# edit .env:
#   FIREWORKS_API_KEY=fw_...
#   FEST_ROUTES=./routes.json
npm run dev
```

`.env` and `routes.json` are both gitignored; `.env.example` (variable names
only) is tracked. Anything else — a real secrets manager, systemd
`EnvironmentFile`, a Kubernetes secret mounted as env — works unchanged, because
Fest only ever reads `process.env`.

The value is read at the moment a request needs it, not snapshotted at boot, so
rotating a key does not require reasoning about whether Fest cached the old one.

**What `.env` must never contain:** `ANTHROPIC_API_KEY` or
`ANTHROPIC_AUTH_TOKEN`. Those belong to the *developer's* environment, and
setting either one there makes Claude Code stop using their Max/Team
subscription and silently bill a key instead. That is the exact
silent-billing-substitution failure this whole design is built against.

Run with `FEST_ROUTES=./routes.json npm start`, or set `FEST_ROUTES` in `.env`.

### Edits apply without a restart

The file is watched, so adding a route takes effect in a second or two. This
matters more than convenience: `node --watch` only tracks imported `.ts` files,
so before this an edit to `routes.json` appeared to do *nothing* — which reads
as "my config is wrong" rather than "it has not been loaded".

**An invalid edit is rejected and the previous table stays in force.** A typo
must change nothing, loudly — degrading to "no routing" would silently push
substituted traffic back onto developers' subscriptions, which is the exact
failure this project is built against. There is a `stat` backstop alongside
`fs.watch`, because watch events are dropped immediately after attach and never
fire at all on some container mounts.

### `expose`: making a substitution visible in `/model`

Claude Code **dedupes** gateway menu entries against its built-in list, so
publishing `claude-sonnet-5` collides with the built-in Sonnet and is dropped
silently. The destination label could therefore never render for exactly the
models most likely to be substituted.

`expose` publishes a distinct, non-colliding id that routes to the same place:

```jsonc
{ "id": "sonnet-to-kimi", "match": "claude-sonnet-*", "upstream": "fireworks",
  "model": "accounts/fireworks/models/kimi-k2p7-code",
  "expose": "claude-kimi-k2-code" }
```

It appears in the picker as `claude-kimi-k2-code → fireworks`, under "From
gateway". The alias must still match `/(claude|anthropic)/i` or the client
filters it out — Fest rejects one that would not, at boot, because a vanishing
entry is indistinguishable from a working config.

### Matching

First the most **exact** rule, then the **longest** wildcard, then file order.
Exactness beating file order is deliberate: a real table is one broad rule plus
a few deliberate exceptions, and if file order decided, adding an exception
below the catch-all would silently do nothing — with no error, because both
rules are individually valid.

Only a trailing `*` is supported. No regular expressions: a routing table gets
read under pressure during an incident, and `claude-*` is unambiguous to
everyone in the room in a way that `^claude-(?!opus).*$` is not.

A request whose model cannot be read is **never routed**. Routing something we
could not identify is how traffic reaches a provider nobody chose.

## The two rules

**A subscription bearer is never sent to a substitute provider.** It was issued
by Anthropic, for Anthropic. Forwarding it to Fireworks would disclose a
developer's personal credential to a third party. It is recorded as `skipped`
with the reason, so the decision is visible rather than merely correct.

**A missing server credential refuses the request.** It does not fall back to
the pass-through path. Falling back would serve a different model than the one
asked for, on a credential the requester did not choose — and the request
*succeeding* is exactly what makes that dangerous, because nobody investigates
a success.

```
400 invalid_request_error
Fest: route "oss" sends "gpt-oss-120b" to upstream "fireworks", whose credential
env:FIREWORKS_API_KEY is not set on the Fest server. This request was refused
rather than served on a different credential.
```

## What gets recorded

Every usage record carries `pipeline`, `routeId`, and `credentialsConsidered` —
including the trivial single-candidate case. Silent credential substitution is a
billing incident: the developer believes their subscription paid, the org is
invoiced, and without an always-present list nothing records that a choice was
even made. In the dashboard the credential pill's tooltip is that list.

`credentials_considered` is JSON on the raw row, under a `CHECK` constraint that
rejects secret-shaped content. There is no column here a credential belongs in,
and the constraint makes that structural rather than customary.

**Not a rollup dimension.** `pipeline` is deliberately absent from
`usage_hourly`: adding it would mean rebuilding the cube's primary key and
revisiting the writer's key de-duplication, and a mistake there multiplies every
token count in the org totals — which is the bug that shipped and was caught in
Phase 2. The aggregate question is already answered, because a substituted
request is `credential_origin = 'fallback_server'`, which *is* a rollup
dimension. The cost: per-**route** breakdowns read raw rows and go blank after
retention, the same honest limitation the error breakdown carries.

## Byte-for-byte, and where it stops applying

The pass-through path forwards bytes verbatim because an Anthropic OAuth token
is validated against request shape. The substitute path rewrites the `model`
field, and that is safe **there** because the request goes to a different vendor
on a different credential, so no signature depends on the bytes.

The rewrite is still surgical rather than a `JSON.parse`/`stringify` round trip,
for two reasons unrelated to signatures: `cache_control` markers must survive
untouched (losing them silently destroys prompt caching and inflates every
bill), and a Claude Code request is routinely megabytes that we should not copy
to change twenty bytes. If anything about the body is unexpected, the original
bytes are returned unchanged — a failed rewrite must never corrupt a request.

## Verified against the live Fireworks API (2026-09-21)

The compatibility claim is now tested, not inferred.

- `POST https://api.fireworks.ai/inference/v1/messages` returns **200** with an
  Anthropic-shaped body and Anthropic-shaped `usage`
  (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`).
- Streaming emits `message_start`, `content_block_delta`, `message_delta`,
  `ping` — so the existing SSE parser and usage accumulator meter this path
  unchanged. Checked by feeding the real captured bytes through the accumulator.

### One behavioural difference worth knowing

Anthropic reports input tokens in `message_start`. **Fireworks sends zeros
there** and the real figures only in `message_delta`, at the END of the stream:

```
message_start  usage: input 0,  cache_read 0
message_delta  usage: input 1,  cache_read 73, output 24
```

Totals are correct either way — the accumulator merges last-wins per field — but
an **aborted** Fireworks stream records `input_tokens: 0`, where an aborted
Anthropic stream still captures them from `message_start`. Those records are
already flagged `partial`, so this is a fidelity limit on cancelled turns rather
than a wrong number. A mock could not have surfaced it.

### Two bugs the live test found that mocks could not

1. **The upstream path prefix was being discarded.** `new URL("/v1/messages",
   base)` treats a leading slash as absolute and drops the base's own path, so
   `https://api.fireworks.ai/inference` became
   `https://api.fireworks.ai/v1/messages` — a 404 from the provider. Invisible
   to every test here, because a mock upstream at `http://127.0.0.1:PORT` has no
   prefix to lose. Fixed in `adapters/url.ts`; the integration mocks now mount
   under `/inference` so the prefix is always exercised.

2. **`FEED_COLUMNS` never selected the new columns.** The writer stored
   `pipeline`, `route_id` and `credentials_considered` correctly and the row
   mapper read them correctly, but the SELECT list omitted them — so the API
   returned the *schema defaults*. Every substituted request reported
   `pipeline: "passthrough"`, `routeId: null` and an empty credential trail:
   plausible values, uniformly wrong. A test now asserts the SELECT list covers
   every column the mapper reads, so the next added field fails loudly instead
   of defaulting quietly.
