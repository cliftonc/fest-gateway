# Design: `fest claude` posture auto-detection and the `gw` override

## Status

**Implemented.** Kept as the record of *why* — Claude Code's discovery behaviour
and the mutual exclusivity below were derived by reading the 2.1.278 client, and
are not re-derivable from the diff. The shipped code is `cli/claude.ts`,
`shared/base-models.ts`, the `claude` case in `server/bin/fest.ts`, and
`test/cli-claude.test.ts`.

## Problem

`/model claude-deepseek-v4` fails with

> Model 'claude-deepseek-v4' not found

even though `routes.json` publishes that id (`match` *and* `expose`, to Fireworks
`deepseek-v4-pro`) and `FEST_ROUTES` is set.

## Why it happens

`fest claude` unconditionally selects **subscription posture**:

- sets `ANTHROPIC_BASE_URL=<gateway>/t/<identity-token>`,
- strips every var in `shared/demotion-vars.ts` from the child,
- relies on Claude Code's own Anthropic OAuth login for the upstream bearer.

Gateway model discovery (`GET /v1/models`, rendered under `/model` as "From
gateway") requires a credential in `ANTHROPIC_AUTH_TOKEN` / `apiKeyHelper` / an
API key — which is precisely what disables subscription auth. In 2.1.278 a
server-published menu and subscription pass-through are **mutually exclusive**.
So in subscription posture the picker shows only Claude Code's built-in list, and
a gateway-only id cannot be selected.

This is a deliberate trade-off in the client, not a bug in Fest's token handling.

## Goal

`fest claude` picks the posture that will actually work for the developer's
machine; `gw` forces gateway posture when they want the menu anyway.

- **Default:** auto-detect. Anthropic OAuth login present → subscription posture.
  Absent → gateway posture.
- **Override:** `fest claude gw` → always gateway posture.

There is deliberately no `sub` counterpart. The only case auto-detect sends to
gateway posture is "no subscription login exists", and forcing subscription there
could not work regardless — so the override only needs to point one way.

## Detection

### Subscription login

Read `~/.claude.json` the way `tools/canary.ts::subscriptionLogin()` already
does — metadata only, never a credential value:

- file exists and `oauthAccount` present → subscription posture,
- otherwise → gateway posture, carrying the reason for the notice line.

### Settings-layer demotion (new, and load-bearing)

`cli/claude.ts` strips demotion vars from `process.env`, but Claude Code also
reads them from its own settings layers, which no env manipulation can clear:

```
~/.claude/settings.json
~/.claude/settings.local.json
<cwd>/.claude/settings.json
<cwd>/.claude/settings.local.json
```

`tools/canary.ts::settingsTriggers()` already scans these by **key only** and
treats a hit as disqualifying. `fest claude` must do the same scan and, when it
finds `apiKeyHelper` or `env.ANTHROPIC_API_KEY` / `env.ANTHROPIC_AUTH_TOKEN`
while about to run in subscription posture, warn loudly: the developer believes
they are on their own plan, and the client will quietly put them on someone
else's key. Name the file and the key; never read the value.

This matters more once posture is auto-detected, because the chosen posture is
now something Fest asserts rather than something the developer typed.

## Posture behaviour

### Subscription posture

- strip all of `DEMOTION_VARS`,
- set `ANTHROPIC_BASE_URL = ${cfg.serverUrl}/t/${cfg.identityToken}`,
- do **not** set `ANTHROPIC_AUTH_TOKEN`.

Developer's own plan pays. `/model` shows built-ins only.

### Gateway posture

- strip all of `DEMOTION_VARS` first, then
- set `ANTHROPIC_BASE_URL = ${cfg.serverUrl}` (no `/t/<token>` prefix),
- set `ANTHROPIC_AUTH_TOKEN = ${cfg.identityToken}`.

Strip-then-set, rather than exempting `ANTHROPIC_AUTH_TOKEN` from the strip list:
that way an inherited `ANTHROPIC_API_KEY` can never survive alongside the Fest
token.

The token is `fest_…`, so `server/auth/posture.ts` classifies it as
`FEST_IDENTITY_TOKEN`, lifts it out as identity, leaves `upstreamCredential`
null, and reports posture `key`. Requests are served by the substitute pipeline
on server-held credentials. **Org spend, not the developer's plan** — the notice
line must say so.

## Preflight: servability, not merely a non-empty menu

This is the part the first draft got wrong. "The menu is non-empty" does not mean
the model the session will actually open on is routed. In gateway posture there is
no caller credential to fall back on, so an unrouted model 401s on the first
message.

Worked against the repo's current `routes.json`
(`claude-sonnet-*` → kimi with `expose: claude-kimi-k2-code`;
`claude-deepseek-v4` → deepseek-v4-pro):

| candidate | resolves to | in menu? |
| --- | --- | --- |
| `claude-opus-5` | no route → passthrough | ✗ dropped |
| `claude-sonnet-5` | `claude-sonnet-*` → substitute | ✓ (then dropped *client*-side by dedupe) |
| `claude-haiku-4-5-20251001` | no route → passthrough | ✗ dropped |
| `claude-deepseek-v4` | substitute | ✓ |
| `claude-kimi-k2-code` | `expose` → substitute | ✓ |

So the menu is non-empty and the old preflight passes — yet a session that opens
on Opus 5 or Haiku 4.5 fails immediately. That is the cliff to close.

### What the preflight does

1. **Fetch** `GET ${cfg.serverUrl}/v1/models?limit=1000`, 3s timeout.
   - `404` or empty `data` → **hard error**: gateway posture needs substitute
     routes; point at `FEST_ROUTES`.
   - network error / timeout → **warn and continue**; a flaky link must not brick
     a known-good gateway.
2. **Determine the intended model**, in the precedence the CLI can observe:
   1. `--model <id>` among the forwarded claude args,
   2. `ANTHROPIC_MODEL` in the environment,
   3. a `model` key in any settings layer (same four files as above),
   4. otherwise *unknown* — Claude Code's own default or last-selected, which the
      CLI cannot see.
3. **Decide**:
   - intended model known and **not** in the served menu → **hard error** naming
     it and listing the servable ids,
   - intended model known and servable → proceed silently,
   - intended model unknown → diff the served menu against the shared base-model
     list and, for any base model missing, warn precisely:
     > Opus 5 and Haiku 4.5 are not routed on this gateway; selecting either will
     > fail. Servable: claude-deepseek-v4, claude-kimi-k2-code, claude-sonnet-5.

Step 3's last branch is what turns a first-message 401 into a sentence read
before the session starts.

### Shared base-model list

Step 3 needs the same base ids `server/api/models.ts` seeds its menu from
(`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`). Move them to
**`shared/base-models.ts`**, imported by both, exactly as
`shared/demotion-vars.ts` is shared by `cli/claude.ts` and `tools/canary.ts` so
the two lists cannot drift. Do not re-type the ids in `cli/`.

## CLI changes

### `server/bin/fest.ts`

In `case "claude"`, before dispatching:

- if the first positional arg is exactly `gw`, consume it → `posture: "key"`,
- otherwise → `posture: "auto"`,
- preserve existing `--` handling; `gw` is only recognised *before* `--`, so
  `fest claude -- gw` still forwards `gw` to the child,
- `fest claude gw --resume` must work.

Update `printHelp()` and the file header comment:

```
  fest claude [gw] [-- claude args...]
```

### `cli/claude.ts`

- `detectSubscriptionLogin()` — `~/.claude.json`, metadata only.
- `settingsDemotionTriggers()` — the four-layer key-only scan.
- `buildClaudeEnv(base, cfg, posture)` — takes a *resolved* posture
  (`"subscription" | "key"`), stays pure and directly testable. Default the
  parameter to `"subscription"` so existing tests keep passing unchanged.
- `resolveIntendedModel(argv, env)` — the precedence list above; pure.
- `checkServable(menu, intended)` — pure; returns `ok` / `fatal` / `warn` plus the
  message. Keeping this out of the fetch makes the cliff logic unit-testable
  without a socket.
- `runClaude(argv, posture)` — resolve auto → concrete posture, print the notice
  and any warnings to **stderr**, run the preflight in gateway posture, then
  spawn.

## Notices and warnings

One line each, to stderr, before the spawn:

- `fest claude: subscription posture (Anthropic OAuth login found) — your own plan pays.`
- `fest claude: gateway posture (no Anthropic subscription login found) — org credentials pay.`
- `fest claude gw: gateway posture forced — org credentials pay.`

Conditional:

- subscription posture **and** a settings-layer demotion trigger →
  `<file>: <key> will demote this session off your subscription. Clear it or expect org billing.`
- subscription posture **and** `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` set →
  `Gateway model discovery is unavailable in subscription posture. Use \`fest claude gw\`.`
- gateway posture **and** `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` unset →
  `Export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 to see gateway models in /model.`
- gateway posture **and** `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` set →
  `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL disables gateway discovery. Unset it.`
  (Warn, do not strip — it is an explicit override.)
- the unrouted-base-model warning from the preflight.

## Tests — `test/cli-claude.test.ts`

Existing subscription-posture tests stay as they are (parameter defaults to
`"subscription"`).

Add, all against pure helpers:

- gateway posture: `ANTHROPIC_BASE_URL` equals `serverUrl` with no `/t/`,
  `ANTHROPIC_AUTH_TOKEN` equals the Fest token, inherited `ANTHROPIC_API_KEY` and
  `ANTHROPIC_AUTH_TOKEN` are gone, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`
  survives.
- `resolveIntendedModel`: `--model` beats `ANTHROPIC_MODEL` beats a settings
  `model` key; none present → unknown.
- `checkServable`: known-and-servable → ok; known-and-absent → fatal naming the
  id; unknown with a base model missing → warn naming exactly the missing ones.
  Use the real `routes.json` shape as a fixture so the Opus/Haiku cliff is the
  case under test.
- settings-layer scan reports the key and never the value (override `HOME`, then
  dynamic `import()`, as `cli-config.test.ts` / `cli-login.test.ts` do).

Preflight fetch behaviour (404 → fatal, empty `data` → fatal, network error →
warn) via a stubbed `globalThis.fetch`, following the `mockHealthyGateway`
pattern in `cli-login.test.ts`.

## Docs to update

- **`docs/CLI-AUTH.md`** — rewrite the `fest claude` bullet: auto-detection, the
  `gw` override, who pays in each posture, the
  `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` requirement, and the fact that in
  gateway posture every selected model needs a substitute route.
- **`docs/POSTURES.md`** — name `fest claude gw` as the supported way to reach key
  posture, in the `GET /v1/models` section next to the existing manual env recipe.
- **`cli/CLAUDE.md`** — the "Maintaining this" list already says anything spawning
  `claude` must clear `shared/demotion-vars.ts`; add that gateway posture sets
  `ANTHROPIC_AUTH_TOKEN` *after* that strip, never by exempting it.

## Verification

1. `npm test` and `npm run typecheck` clean.
2. With an `oauthAccount` in `~/.claude.json` (the current machine):
   `fest claude` → subscription posture, path-prefixed base URL, no
   `ANTHROPIC_AUTH_TOKEN`.
3. Same machine, `fest claude gw` → gateway posture, `ANTHROPIC_AUTH_TOKEN` set,
   bare base URL, and the unrouted-base-model warning naming Opus 5 and Haiku 4.5
   against the current `routes.json`.
4. `fest claude gw --model claude-opus-5` → hard error before spawning, listing
   the servable ids.
5. `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 fest claude gw`, then `/model` →
   `claude-deepseek-v4` and `claude-kimi-k2-code` appear under "From gateway";
   selecting `claude-deepseek-v4` serves a turn. (`claude-sonnet-5` is expected to
   be absent from that section — the client dedupes it against its built-in
   Sonnet, which is why the `expose` alias exists.)
6. Against a gateway with no `FEST_ROUTES`: `fest claude gw` errors before
   spawning rather than failing on the first message.

## Notes

- No server-side change. `server/auth/posture.ts`, `server/api/models.ts` and
  `server/pipeline/dispatch.ts` already behave correctly for both postures; this
  is entirely about which client env Fest hands the child.
- Auto-detect changes who pays for a developer with no Anthropic subscription
  login: today they get a broken subscription posture, afterwards they get
  gateway posture on org credentials. That is the intent, and it is why the
  notice line states the billing consequence every time rather than only on `gw`.
- `/v1/models` is served without identity resolution (`server/http/server.ts`
  handles it before `detectInbound`), so the preflight needs no auth header. Worth
  knowing, but out of scope here.
