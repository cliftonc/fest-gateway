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

## ⚠ Not yet verified against the live Fireworks API

The Fireworks adapter assumes Fireworks serves an **Anthropic-compatible**
`/v1/messages`. That is inferred from `fireconnect`, which points Claude Code at
`https://api.fireworks.ai/inference` as `ANTHROPIC_BASE_URL` — which only works
if the Messages request and SSE formats are accepted. Strong evidence, but
inference, not a test: there was no Fireworks key available when this was
written.

Consequences if the assumption is wrong: the adapter would need request and
response translation, and — more importantly — its own stream reader, because
the current path reuses the Anthropic SSE parser and usage accumulator
unchanged. The routing, credential and visibility work is unaffected either way.

**Owed:** one real request against Fireworks with a live key, checking that
`/v1/messages` is accepted and that `message_start`/`message_delta` usage events
arrive in the shape the accumulator expects.
