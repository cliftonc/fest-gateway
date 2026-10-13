# GitHub Copilot CLI through Fest

Fest meters Copilot CLI on the developer's own Copilot login, the way it meters
Claude Code on a Claude subscription: the developer's plan pays, and their
credential is forwarded to GitHub and never stored. Bring-your-own-key modes
are there as well, for running Copilot on a model key instead.

```bash
fest copilot               # Copilot on its own login: your Copilot plan pays
fest copilot anthropic     # BYOK on your ANTHROPIC_API_KEY
fest copilot gw            # BYOK on the gateway's own routes (org pays)
fest copilot openai        # BYOK on your OPENAI_API_KEY, Responses API (needs COPILOT_MODEL)
```

## On the Copilot login

Copilot CLI sends its model traffic to the Copilot API host its account
belongs to, which GitHub names per plan in the `copilot_internal/user`
response: `api.individual.githubcopilot.com`, `api.business.…` or
`api.enterprise.…`. Copilot's `COPILOT_API_URL` replaces that host.
`fest copilot` sets it to

```
<fest>/t/<your-fest-token>/copilot/<plan>
```

and Fest relays each request to the same GitHub host Copilot would have used.

**The plan.** `fest copilot` reads it from Copilot's own cache of that
response (`copilot-user-cache.json`, under `~/Library/Caches/copilot` on macOS
and `~/.cache/copilot` on Linux), taking only `endpoints.api` from the account
that refreshed most recently. `FEST_COPILOT_PLAN=individual|business|enterprise`
overrides it. A host outside those three, such as a GHE.com data-residency
tenant, is refused with its name rather than guessed at.

**What is metered.** Copilot picks one of three APIs per model, and Fest
meters all three as the developer's subscription, priced as notional
list-rate value as Claude and ChatGPT plans are:

| Path | API | Models |
| --- | --- | --- |
| `POST /v1/messages` | Anthropic Messages | Claude |
| `POST /responses` | OpenAI Responses | GPT-5 and later |
| `POST /chat/completions` | OpenAI Chat Completions | the rest, and Copilot's utility calls |

Everything else under the mount (`/models`, `/auto` model routing, and
whatever else Copilot calls) is relayed as is and not recorded. It uses no
tokens, as with `count_tokens`. Rows are labelled `copilot` from the
`copilot-integration-id` header, and the session is `x-client-session-id`,
the same id `copilot --resume` takes.

**The built-in GitHub MCP server.** Copilot sends its calls to
`<origin>/mcp/readonly`. It builds that URL from the API URL's origin and
drops its path, so those calls reach Fest's root with no token and no plan.
Fest relays root-level `/mcp/…` to `https://api.githubcopilot.com`, the one
host GitHub serves that server from. Nothing is recorded, because there is no
identity to attribute it to. This is the one unauthenticated relay in Fest.
It is safe because the upstream is fixed and the caller's own credential is
what GitHub checks. `FEST_COPILOT_MCP_BASE_URL=off` turns it off. A gateway
mounted under a path does not own its origin's root, so there `fest copilot`
starts Copilot with `--disable-mcp-server github-mcp-server` and says so.

**Server settings.** `FEST_COPILOT_BASE_URL` (default
`https://api.{plan}.githubcopilot.com`; `{plan}` is filled in per request) and
`FEST_COPILOT_MCP_BASE_URL` (default `https://api.githubcopilot.com`). Each must
be https unless it is loopback, and `off` refuses the mount. The plan segment
must be one of the three; anything else is a 404. That is what keeps the mount
from relaying to a host a caller names.

### The GitHub token

Copilot authenticates every call with `Authorization: Bearer gho_…`. That is
the GitHub OAuth token of its own login, which carries `repo` and other
GitHub scopes, and Copilot does not swap it for a short-lived Copilot token.
That makes it broader than a model key, so this is exactly what Fest does
with it:

- It forwards it upstream in the header it arrived in, unchanged, to GitHub's
  Copilot API host (or GitHub's MCP host), and nowhere else.
- It keeps a 12-hex-character SHA-256 fingerprint on the request row. This is
  the same non-reversible correlation id every relayed credential gets.
- It never writes the token to a log line, an error message, the store, the
  JSONL trail or the live feed. The log scrubber and the upstream-error
  scrubber both redact `gh[opsu]_…` and `github_pat_…`. The credential's
  recorded prefix is cut to the family (`gho_`), so not even the leading
  characters are kept.

`test/copilot-http.test.ts` verifies this. It drives the real server, store
and writer with a sentinel `gho_` token through:
- every path above;
- an upstream refusal that echoes the token back in its body and headers;
- a stream that dies mid-way;
- an unreachable upstream.

Then it scans the SQLite database, its WAL, the JSONL trail, the in-memory
ring and everything logged to stderr for the token. The test goes red when
either scrubber is disabled. To check a live deployment yourself:

```bash
grep -a -c -E 'gh[opsu]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}' data/fest.db* data/usage.jsonl
```

To narrow what crosses the gateway, a developer can sign Copilot in with a
fine-grained personal access token that has only the **Copilot Requests**
permission (`COPILOT_GITHUB_TOKEN=github_pat_…`). Copilot accepts one, and it
can do nothing else on GitHub. `fest copilot` leaves that variable alone.

**The Fest token** travels in the URL path, the same way it does in
`ANTHROPIC_BASE_URL` for `fest claude`, because on its own login Copilot sends
no custom headers. Copilot may write that URL to its own local logs under
`~/.copilot`.

### Limits

- Copilot reports its own cost per turn as AI credits: `copilot_usage.total_nano_aiu`
  on `response.completed`, plus a per-token-type price list. Fest does not
  record it yet. Its notional value comes from its own price table, which may
  not match what GitHub charges against the plan.
- Copilot's plan quota (`x-quota-snapshot-chat`, `…-premium_interactions`, …)
  is monthly, so it is relayed to Copilot but not written into the 5h/7d quota
  columns, which would misdescribe it.
- `COPILOT_API_URL` is not listed in `copilot help environment`. It works as of
  Copilot CLI 1.0.96, and a release could change it.

## Bring your own key

Copilot CLI's `COPILOT_PROVIDER_*` variables point it at any Anthropic- or
OpenAI-compatible endpoint, and in those modes a model key pays, not the
Copilot plan:

| Variable | `anthropic` | `gw` | `openai` |
| --- | --- | --- | --- |
| `COPILOT_PROVIDER_TYPE` | `anthropic` | `anthropic` | `openai` |
| `COPILOT_PROVIDER_BASE_URL` | `<fest>` | `<fest>` | `<fest>/openai/v1` |
| credential | `API_KEY` = your `ANTHROPIC_API_KEY` | `BEARER_TOKEN` = your Fest token | `API_KEY` = your `OPENAI_API_KEY` |
| `COPILOT_PROVIDER_HEADERS` | `X-Fest-Client`, `X-Fest-Token` | `X-Fest-Client` | `X-Fest-Client`, `X-Fest-Token` |
| `COPILOT_MODEL` | yours, else the Sonnet base model | same | required |

Every mode, including the login one, first clears any inherited
`COPILOT_PROVIDER_*`, `COPILOT_PROVIDERS_CONFIG`, `COPILOT_API_URL` and
`COPILOT_OFFLINE`. Copilot ranks `COPILOT_PROVIDER_BEARER_TOKEN` above
`COPILOT_PROVIDER_API_KEY`, so a stale bearer would silently send the wrong
credential, and any provider at all takes a session off the Copilot plan. A
Claude subscription token (`sk-ant-oat…`) in `ANTHROPIC_API_KEY` is refused,
because only Claude Code can use one.

On the server, the `anthropic` and `gw` modes use the existing Anthropic path:
`POST /v1/messages`, metered and priced exactly as Claude Code's key posture
is. `gw` mode goes through the routing table like `fest claude gw`.

## What the wire looks like

**Login mode**, captured with Copilot CLI 1.0.96 through a relay to
`api.individual.githubcopilot.com`:

- Copilot keeps the API URL's path for model calls (`/models`, `/auto`,
  `/responses`), and drops it for MCP (`/mcp/readonly`).
- It tries `/responses` as a WebSocket upgrade first, and falls back to HTTP
  SSE when refused. Fest refuses it.
- Headers: `copilot-integration-id: copilot-developer-cli`,
  `editor-version: copilot/<version>`, `x-github-api-version`,
  `x-client-session-id`, `x-interaction-id`, `x-initiator`,
  `x-interaction-type`.
- Responses carry `x-github-request-id` and `x-quota-snapshot-*`. MCP
  responses carry `mcp-session-id`, which Fest relays like every other
  non-credential header on this mount.

**BYOK**, captured with the Phase 0 capture server and Copilot CLI 1.0.91:

- Copilot appends `/v1/messages` to the base URL and keeps any path on it
  (`/t/<token>` works too).
- It sends the key as `x-api-key`, and makes no `/v1/models` call.
- Its user-agent is the stock SDK's (`Anthropic/JS 0.94.0`); what marks it
  as Copilot is `x-initiator` and `x-interaction-type`. Fest uses those to
  label rows when `X-Fest-Client` is absent.
- It sends **no session id**, so BYOK rows have no session.
