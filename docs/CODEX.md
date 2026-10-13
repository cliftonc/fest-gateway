# Codex CLI through Fest

Fest meters OpenAI's Codex CLI the way it meters Claude Code: the developer's
own credential is forwarded and forgotten, and each turn becomes a row with
tokens, cost, session and quota. Developers run:

```bash
fest codex                 # interactive, on whatever Codex is logged in with
fest codex exec "…"        # any codex subcommand or flag passes through
fest codex key             # force API-key mode on a machine with a ChatGPT login
```

## Two mounts, two ways to pay

| Codex login | Fest mount | Upstream | Who pays | Recorded as |
| --- | --- | --- | --- | --- |
| ChatGPT (`codex login`) | `/chatgpt/backend-api/codex` | `https://chatgpt.com` | the developer's ChatGPT plan | `subscription`: no org spend, notional value, 5h/7d quota |
| API key | `/openai/v1` | `https://api.openai.com` | the key's owner | `list`: priced spend |

Both mounts are on by default. `FEST_OPENAI_BASE_URL` and `FEST_CHATGPT_BASE_URL`
move them (https only, loopback excepted), and `off` disables either. Like
`/bedrock`, they bypass the routing table: no rule can swap a server-held key in
under a request that says "relay on my credential".

The ChatGPT mount follows the gateway pattern OpenAI documents for ChatGPT
workspaces ("Sign in with ChatGPT through a gateway"). Codex keeps its own login
and sends its access token and `ChatGPT-Account-ID`; Fest relays them. On a
Plus or Pro plan it works the same way, but OpenAI documents it only for
workspaces, so check your plan's terms before rolling it out.

## How `fest codex` wires it

Current Codex has no base-URL environment variable; a gateway is a custom model
provider. `fest codex` defines one for the life of the process with `-c`
overrides and never edits `~/.codex/config.toml`:

```text
-c model_provider="fest"
-c model_providers.fest.base_url="<fest>/chatgpt/backend-api/codex"   # or <fest>/openai/v1
-c model_providers.fest.wire_api="responses"
-c model_providers.fest.requires_openai_auth=true                       # or env_key="OPENAI_API_KEY"
-c model_providers.fest.env_http_headers={ "X-Fest-Token" = "FEST_GATEWAY_TOKEN" }
-c model_providers.fest.http_headers={ "X-Fest-Client" = "codex" }
```

The mode comes from `auth_mode` in `~/.codex/auth.json` (only that key is read).
The identity token is in the child's environment, never in argv. To set this up
by hand without the CLI, put the same keys in a `[model_providers.fest]` table in
your own `config.toml`.

## What the wire looks like

Captured with the Phase 0 capture server and codex-cli 0.162.1:

- `GET …/models?client_version=…` once per session (~600KB on chatgpt.com,
  cached by Codex against `x-models-etag`). Fest relays it and does not meter it.
- `POST …/responses`, which streams Responses-API SSE. Usage arrives once, on
  `response.completed` (or `response.incomplete`). Fest splits `input_tokens`,
  which *includes* `cached_tokens`, into its disjoint buckets. See
  [PRICING.md](PRICING.md).
- chatgpt.com sends that stream **with no content-type**. Fest labels it
  `text/event-stream`.
- Every response carries `x-codex-turn-state`, which Codex echoes on its next
  request, and `x-codex-primary-*` / `x-codex-secondary-*` quota windows (300
  and 10080 minutes). Fest relays all `x-codex-*` headers and records the two
  windows in the same 5h/7d columns as Anthropic's.
- `session-id` is the session; `originator` is `codex_cli_rs` or `codex_exec`.

## Not covered

- **WebSocket transport.** Codex's built-in OpenAI provider prefers Responses
  over WebSocket; a custom provider (which is what `fest codex` defines)
  defaults to HTTP+SSE, which is what Fest relays.
- **The Chat Completions wire.** Codex dropped it (`wire_api = "chat"` is an
  error now).
- **`/wham/*` account endpoints** (usage page, cloud tasks). Codex sends those
  to `chatgpt_base_url`, not to the model provider, so they never reach Fest.
