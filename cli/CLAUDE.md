# cli/

The developer half of the CLI: `fest login`, `whoami`, `claude`, `logout`.
Dispatched from `server/bin/fest.ts`'s `CLIENT_COMMANDS` set, before
`loadConfig()` is ever called.

- `config.ts` — read/write/clear `~/.fest/config.json` (mode 0600, dir 0700).
  `FEST_TOKEN`/`FEST_SERVER_URL` env vars override the file, for CI.
- `login.ts` — the loopback OAuth flow: a temp HTTP server on `127.0.0.1`,
  a browser opened at `{server}/api/auth/oauth/{provider}/start`, waits for
  the callback with a minted token. Checks `GET {server}/healthz` first —
  see the comment on `checkIsGateway` before touching that.
- `whoami.ts` — local config + a live check against `/api/auth/identity`.
- `claude.ts` — spawns the real `claude` binary in one of two postures,
  auto-detected from `~/.claude.json` and forceable with `fest claude gw`.
  `buildClaudeEnv`, `detectSubscriptionLogin`, `settingsDemotionTriggers`,
  `resolveIntendedModel`, `checkServable` and `postureWarnings` are all pure
  and tested; only `fetchServableModels` and the spawn touch the world.
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
