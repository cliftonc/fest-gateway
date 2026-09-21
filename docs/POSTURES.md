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
request must be served by a route with a server-held credential. A model with no
route gets an explicit 401 that says *this is a server configuration problem,
not a problem with your token* — otherwise the developer spends the afternoon
re-checking the one thing that is not wrong.

## `GET /v1/models`

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
