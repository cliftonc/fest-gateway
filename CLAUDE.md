# Fest

Self-hosted Claude Code gateway. See `README.md` for what it does and why.

## Build

There is no server build step. Node runs the TypeScript directly (native type
stripping, Node >= 22.18). Only the dashboard has a build.

```bash
npm install          # once
npm run typecheck     # tsc --noEmit, twice: root config, then web/tsconfig.json
npm test              # node --test "test/**/*.test.ts"
npm run dev            # gateway (node --watch) + dashboard (Vite, HMR), one terminal
npm run build           # web/dist — only needed for `npm start` / Docker / npm run cli
npm start                # the built gateway, serving web/dist if present
npm run cli -- <cmd>       # the fest CLI, e.g. `npm run cli -- whoami`
npm run canary               # version gate — re-run before rolling out a new Claude Code release
```

`npx fest <cmd>` and `npm link` also work — see the root `README.md`.

Before committing: `npm test` and `npm run typecheck` both clean.

## Layout

One `CLAUDE.md` per top-level folder — read the relevant one before working in
`cli/`, `docs/`, `server/`, `shared/`, `test/`, `tools/`, or `web/`.
