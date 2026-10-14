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
- `bench/` — `npm run bench`, the performance harness: `run.ts` orchestrates
  (fixture → real `fest serve` per worker count → staged load → drain → DB
  check → profiled pass → report), `fixture.ts` builds the database through the
  real store modules, `upstream.ts` is the fake SSE upstream that stamps each
  chunk, `load.ts` is a load-generator process, `probe.ts` is preloaded into
  every gateway process via `NODE_OPTIONS`, `profile.ts` reduces
  `.cpuprofile`s, `hist.ts` is the mergeable histogram, and `report.ts` renders
  the self-contained HTML. See `docs/PERF.md`.
- `prices-sync.ts` — `npm run prices:sync`, regenerates the vendored price
  snapshot from litellm. Prints a diff of every changed rate: the output is the
  reviewable part of a commit whose payload is a 66KB binary blob. See
  `docs/PRICING.md`.

## Maintaining this

- These can use anything in `node_modules`/devDependencies freely — unlike
  `server/`, they're never part of the runtime image, so the "no runtime
  dependencies" constraint doesn't apply here.
- The bench must keep driving the REAL gateway binary, and must never need
  bench code in `server/`: everything it measures inside a gateway process
  comes from `probe.ts` via `NODE_OPTIONS`. Profiling stays in its own pass —
  `--cpu-prof` inflates event-loop utilisation several-fold. `report.ts` must
  stay self-contained (no scripts, fonts, images or URLs); `test/bench.test.ts`
  checks it.
- `canary.ts` in particular must keep testing the *real* `claude` binary
  end-to-end, not a reimplementation of what it checks — a canary that tests
  a stand-in tests nothing. If you add a new check, add a corresponding
  staged-regression case to `test/canary.test.ts` too: "a canary that cannot
  go red is worse than none."
