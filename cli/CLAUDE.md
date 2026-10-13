# cli/

The developer half of the CLI: `fest login`, `whoami`, `claude`, `codex`,
`copilot`, `logout`.
Dispatched from `server/bin/fest.ts`'s `CLIENT_COMMANDS` set, before
`loadConfig()` is ever called.

- `config.ts` — read/write/clear `~/.fest/config.json` (mode 0600, dir 0700).
  `FEST_TOKEN`/`FEST_SERVER_URL` env vars override the file, for CI.
- `login.ts` — the loopback flow: a temp HTTP server on `127.0.0.1`, a browser
  opened at `{server}/api/auth/cli/authorize`, waits for the callback with a
  minted token. It opens the *gateway's* authorise route, not a provider's
  `/start`, because only the server can see whether that browser already has a
  session — already signed in means one approval click instead of a Google
  round trip. Checks `GET {server}/healthz` first — see the comment on
  `checkIsGateway` before touching that.
- `whoami.ts` — local config + a live check against `/api/auth/identity`.
- `claude.ts` — spawns the real `claude` binary in one of two postures,
  auto-detected from `~/.claude.json` and forceable with `fest claude gw`.
  `buildClaudeEnv`, `detectSubscriptionLogin`, `settingsDemotionTriggers`,
  `resolveIntendedModel`, `checkServable` and `postureWarnings` are all pure
  and tested; only `fetchServableModels` and the spawn touch the world.
- `codex.ts` — spawns `codex` with `-c` overrides defining a `fest` model
  provider (never edits `~/.codex/config.toml`). ChatGPT login →
  `/chatgpt/backend-api/codex`, else `/openai/v1`, read from `auth_mode` in
  `~/.codex/auth.json` and nothing else in it. The identity token rides in
  `FEST_GATEWAY_TOKEN` via `env_http_headers`, never in argv.
  `buildCodexInvocation` and `detectCodexMode` are pure and tested.
- `copilot.ts` — spawns `copilot`. By default on its own login, with
  `COPILOT_API_URL` at `<fest>/t/<token>/copilot/<plan>`; the plan comes from
  `endpoints.api` in Copilot's user cache (`copilot-user-cache.json`, read for
  that one field only) or `FEST_COPILOT_PLAN`. `anthropic`/`gw`/`openai` are
  BYOK (`COPILOT_PROVIDER_*`). Every mode first clears inherited
  `COPILOT_PROVIDER_*`, `COPILOT_PROVIDERS_CONFIG`, `COPILOT_API_URL` and
  `COPILOT_OFFLINE`: any of them would take the session somewhere else.
  `buildCopilotEnv`, `copilotArgs`, `planFromUserCache` are pure and tested.
  See `docs/COPILOT.md`.
- `logout.ts` — deletes the local file only. Never revokes server-side.

## Maintaining this

- **Nothing here may import from `server/store` or open the database.** This
  code runs on a developer's own laptop, with no access to Fest's SQLite file.
  That boundary is the whole point of a separate `cli/` tree instead of more
  subcommands bolted onto `server/bin/fest.ts` directly.
- A new client command: add a file here, wire it into `server/bin/fest.ts`'s
  `CLIENT_COMMANDS` switch, and update the help text in both `printHelp()` and
  `docs/CLI-AUTH.md`.
- Anything that spawns `claude` must clear `shared/demotion-vars.ts`, not just
  set `ANTHROPIC_BASE_URL` — an inherited `ANTHROPIC_API_KEY` silently demotes
  the session off the developer's subscription.
- Gateway posture sets `ANTHROPIC_AUTH_TOKEN` *after* that strip, never by
  exempting it from the strip list. Exempting it would let an inherited
  `ANTHROPIC_API_KEY` survive alongside the Fest token, and which one the client
  picks is not something this code should be betting on.
- The settings-layer scan (`~/.claude/settings{,.local}.json` and the same two
  under the cwd) reads **keys only**. `env.ANTHROPIC_API_KEY` in a settings file
  is a live secret; it must never reach a terminal or a test assertion.
- Base model ids live in `shared/base-models.ts`, shared with
  `server/api/models.ts`. Do not re-type them here — a drift between the menu
  and the preflight is a warning about a model the server no longer offers, or
  silence about one it does.
- Tests live in `test/cli-*.test.ts`, not here (matches the rest of the repo's
  flat `test/` convention). `openBrowser` on `runLogin` and `buildClaudeEnv`
  are the two deliberate test seams — use them rather than mocking globals
  where you can.
