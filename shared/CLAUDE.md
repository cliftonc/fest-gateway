# shared/

Contracts imported by more than one side of the split — `server/` and
`web/`, or `server/` and `cli/`. Nothing here may import anything that isn't
also safe in a browser bundle: no `node:sqlite`, no `node:fs`, no server-only
module. That's the entire reason this directory exists instead of the web
code importing types straight out of `server/`.

- `types.ts` — the request/usage/SSE/posture/identity/record/quota shapes
  both the server and its internals agree on. Note `UsageRecord` carries two
  dollar fields: `costUsd` (org spend, null on subscription) and
  `notionalCostUsd` (list-rate value, populated on subscription). They are
  never added together — see `docs/PRICING.md`.
- `api.ts` — the dashboard's wire contract (`MeResponse`, `RequestRowWire`,
  etc). `server/api/routes.ts` asserts every response `satisfies` these
  types, so a renamed or removed field is a `tsc` failure at the route, not
  `undefined` in a table cell in the browser. Adding a field is invisible to
  the UI and safe; removing or renaming one is the direction meant to break
  the build.
- `series.ts` — the chart bucket-filling helper (keyed on epoch hour, not a
  formatted clock label — see the Phase 3 note in the main plan doc for why).
- `demotion-vars.ts` — the env vars that silently demote Claude Code off
  subscription auth. One list, imported by both `tools/canary.ts` and
  `cli/claude.ts`, so they can't drift apart.

## Maintaining this

- Before adding an import here, ask whether it would still resolve in a
  browser. If not, the type/value belongs in `server/` and the browser side
  should get a narrower, shared-safe shape instead.
- Changing a field in `api.ts` is a two-sided change: update the server
  response that produces it and the web code that reads it, then let
  `npm run typecheck` (which runs both tsconfigs) prove they still agree.
