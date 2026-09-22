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

## Releasing

Bump `version` in `package.json`, then publish a GitHub Release tagged
`v<version>`. `.github/workflows/publish.yml` re-runs the gate and publishes
via npm trusted publishing (OIDC) — there is no NPM_TOKEN in the repo, and the
workflow refuses to publish if the tag and `package.json` disagree. CI
(`ci.yml`) runs the same gate on every push and PR, plus one check this repo
cannot make locally: it installs the packed tarball and runs the binary.

Published to npm as `fest-gateway`, installing a `fest` binary. Publishing is
the one flow that does not run the TypeScript directly: Node refuses to strip
types under `node_modules`, so `npm run build:package` compiles `server/`,
`shared/` and `cli/` to `dist/` (via `tsconfig.build.json`) and copies the
migrations, the price snapshot and `web/dist` alongside. `prepack` runs both
builds, so `npm publish` is enough — see the root `README.md`.

Before committing: `npm test` and `npm run typecheck` both clean.

## Layout

One `CLAUDE.md` per top-level folder — read the relevant one before working in
`cli/`, `docs/`, `server/`, `shared/`, `test/`, `tools/`, or `web/`.
