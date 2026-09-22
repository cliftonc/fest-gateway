# tools/

Standalone scripts, run directly with `node tools/<name>` — not imported by
the server, not shipped in the Docker image, not part of the `web/` build.

- `dev.mjs` — `npm run dev`'s orchestrator: spawns the gateway
  (`node --watch`) and Vite together, prefixes their output, and kills both
  if either dies.
- `canary.ts` — `npm run canary`, the version-upgrade gate. Drives the real
  `claude` binary and the real Phase 0 capture server; see `docs/CANARY.md`
  before changing its checks.
- `capture-server.ts` — the Phase 0 diagnostic capture server (throwaway by
  design, kept for re-running the gating experiments in `docs/PHASE0.md`).
- `extract-gateway-doc.mjs` — pulls `claude gateway --help`'s output for
  reference, since that's Anthropic's own self-hostable gateway and worth
  comparing Fest against periodically.

## Maintaining this

- These can use anything in `node_modules`/devDependencies freely — unlike
  `server/`, they're never part of the runtime image, so the "no runtime
  dependencies" constraint doesn't apply here.
- `canary.ts` in particular must keep testing the *real* `claude` binary
  end-to-end, not a reimplementation of what it checks — a canary that tests
  a stand-in tests nothing. If you add a new check, add a corresponding
  staged-regression case to `test/canary.test.ts` too: "a canary that cannot
  go red is worse than none."
