# Phase 0 results — run (a), 2026-09-21

Claude Code `2.1.278`, macOS, Max/Team login, `MODE=observe` (nothing left the
machine).

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_CUSTOM_HEADERS \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8899 claude -p "hi"
```

## Verdict: the subscription bearer arrives. Pass-through is viable.

```
 1x HEAD /api/hello              creds=[]                             ua=Bun/1.4.3
10x POST /v1/messages?beta=true  creds=[ANTHROPIC_OAUTH_SUBSCRIPTION] ua=claude-cli/2.1.278 (external, sdk-cli)
```

`Authorization: Bearer sk-ant-oat0…` — the Max/Team OAuth token, sent to a
plain-HTTP loopback third-party host with no API key present anywhere. This
confirms the static reading of the binary empirically.

Still outstanding: **run (e)** — whether Anthropic *accepts* the bearer when
relayed. That is the remaining gate.

## What this changes in the implementation

### 1. `HEAD /api/hello` is a startup reachability probe

Sent by the runtime (`Bun/1.4.3`) with **no credentials**, before any inference.
Fest must answer it cheaply and unauthenticated, or startup degrades. It is not
in the Anthropic API surface — it would have been missed without this run.

### 2. The query string is load-bearing

The path is `/v1/messages?beta=true`, not `/v1/messages`. Routing must match on
pathname and **forward the query string** untouched.

### 3. `anthropic-beta` carries 15 values

```
claude-code-20250219, oauth-2025-04-20, context-1m-2025-08-07,
interleaved-thinking-2025-05-14, thinking-token-count-2026-05-13,
context-management-2025-06-27, prompt-caching-scope-2026-01-05,
mid-conversation-system-2026-04-07, mid-conversation-tool-changes-2026-07-01,
advisor-tool-2026-03-01, effort-2025-11-24, fallback-credit-2026-06-01,
dangerous-tool-use-2026-09-03, afk-mode-2026-01-31, extended-cache-ttl-2025-04-11
```

Forward verbatim on the pass-through path. Filtering or reordering this is a
request-shape change, and `oauth-2025-04-20` is the OAuth flag itself.

### 4. `x-claude-code-session-id` — free session correlation

Claude Code already sends a session id header. The dashboard gets per-session
grouping without inventing a client-supplied identifier. Also present: `x-app`,
`x-stainless-*` (including `x-stainless-retry-count`, useful for spotting retry
storms), `anthropic-dangerous-direct-browser-access`.

### 5. The body carries an attribution block inside the system prompt

`system[0].text` begins:

```
x-anthropic-billing-header: cc_version=2.1.278.4ea; cc_entrypoint=sdk-cli;
```

A synthetic billing-attribution block smuggled into the system prompt. This is
decisive for the byte-for-byte rule: it is *inside* the signed-ish payload, so
any re-serialisation or prompt manipulation risks invalidating it. Forward the
body as opaque bytes.

Body top-level keys: `model, messages, system, tools, metadata, max_tokens,
thinking, context_management, safeguards, output_config, stream`.

- `safeguards` confirms the server-side auto-mode classifier contract; a gateway
  that ignores it should set `CLAUDE_CODE_AUTO_MODE_SERVER=0` clientside.
- `thinking: adaptive`, plus `context_management` and `output_config` — all
  fields a naive proxy might drop.
- 3 system blocks, `cache_control: [null, ephemeral, ephemeral]` — **two cache
  breakpoints**. Stripping these silently destroys prompt caching.
- 16 tools in a trivial `-p "hi"` invocation.

### 6. `accept-encoding: gzip, deflate, br, zstd`

Fest forces `identity` upstream so the SSE stream can be teed for metering. That
*is* a request modification — run (e) must confirm it doesn't affect acceptance.
If it does, the fallback is to inflate in order to meter.

### 7. A 501 is treated as retryable

Claude Code retried the same request 10 times against the capture server's 501.
Two consequences: the capture server now returns a non-retryable `400
invalid_request_error` in observe mode, and Fest's own error mapping must be
deliberate about which statuses invite retries.
