# GitHub Copilot CLI through Fest

Fest can meter Copilot CLI, but **only in its bring-your-own-key (BYOK) mode**,
and in that mode a model-API key pays, not the developer's Copilot seat.

```bash
fest copilot               # Anthropic BYOK on your ANTHROPIC_API_KEY
fest copilot gw            # Anthropic BYOK on the gateway's own routes (org pays)
fest copilot openai        # Responses-API BYOK on your OPENAI_API_KEY (needs COPILOT_MODEL)
```

## Why not the Copilot subscription

Copilot's own model traffic is authenticated with the developer's GitHub token
and sent to GitHub-run endpoints (`api.*.githubcopilot.com`). There is no
supported setting to send it anywhere else. The one undocumented override would
mean Fest receiving and forwarding a raw GitHub token, a credential far broader
than any model key. Third-party Copilot proxies also report accounts being
flagged for exactly this. Fest does not do it.

GitHub's own Copilot usage metrics API reports per-user CLI activity and AI
credits as **daily** totals. That is the supported way to see subscription usage;
importing it into Fest is a possible later addition, not part of this.

## What BYOK gives you

Copilot CLI's `COPILOT_PROVIDER_*` variables point it at any Anthropic- or
OpenAI-compatible endpoint. `fest copilot` sets them up:

| Variable | `fest copilot` | `gw` | `openai` |
| --- | --- | --- | --- |
| `COPILOT_PROVIDER_TYPE` | `anthropic` | `anthropic` | `openai` |
| `COPILOT_PROVIDER_BASE_URL` | `<fest>` | `<fest>` | `<fest>/openai/v1` |
| credential | `API_KEY` = your `ANTHROPIC_API_KEY` | `BEARER_TOKEN` = your Fest token | `API_KEY` = your `OPENAI_API_KEY` |
| `COPILOT_PROVIDER_HEADERS` | `X-Fest-Client`, `X-Fest-Token` | `X-Fest-Client` | `X-Fest-Client`, `X-Fest-Token` |
| `COPILOT_MODEL` | yours, else the Sonnet base model | same | required |

It clears any inherited `COPILOT_PROVIDER_*` first:
`COPILOT_PROVIDER_BEARER_TOKEN` outranks `COPILOT_PROVIDER_API_KEY` in Copilot,
so a stale one would silently send the wrong credential. A Claude subscription
token (`sk-ant-oat…`) in `ANTHROPIC_API_KEY` is refused, because only Claude Code
can use one.

On the server this is the existing Anthropic path: `POST /v1/messages`, metered
and priced exactly as Claude Code's key posture is. `gw` mode goes through the
routing table like `fest claude gw`.

## What the wire looks like

Captured with the Phase 0 capture server and Copilot CLI 1.0.91:

- Copilot appends `/v1/messages` to the base URL and keeps any path on it
  (`/t/<token>` works too).
- It sends the key as `x-api-key`, and makes no `/v1/models` call.
- Its user-agent is the stock SDK's (`Anthropic/JS 0.94.0`); what marks it
  as Copilot is `x-initiator` and `x-interaction-type`. Fest uses those to
  label rows when `X-Fest-Client` is absent.
- It sends **no session id**, so Copilot rows have no session.
