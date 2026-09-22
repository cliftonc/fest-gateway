# docs/

Narrative and reference docs — the "why" and "how it works" that don't belong
in code comments because they span multiple files, or that a person needs
before running an experiment rather than while reading a diff. The root
`README.md` is the entry point and links out to these; nothing in here
duplicates it.

- `PHASE0.md` / `PHASE0-RESULTS.md` — the gating experiment that proves
  subscription pass-through works at all, and what it found. Read before
  touching anything in `server/pipeline/passthrough.ts` or `server/auth/posture.ts`.
- `CANARY.md` — `npm run canary`: what it checks, its exit codes, why it's a
  gate run before every Claude Code upgrade rather than a one-time test.
- `POSTURES.md` — subscription vs. key posture, and why they're mutually
  exclusive with model discovery.
- `ROUTING.md` — the routing table format and the substitute path.
- `CLIENT-GATEWAY-PROTOCOL.md` — the wire-level details of what Claude Code
  actually sends (headers, quota, model menu format).
- `FRONTEND.md` — the dashboard's screens and data flow.
- `CLI-AUTH.md` — OAuth setup and the `fest login`/`whoami`/`claude`/`logout`
  flow end to end.
- `canary-history.jsonl` — **data, not documentation.** Appended to by
  `npm run canary`; don't hand-edit it, don't treat it as something to keep
  in sync with prose changes elsewhere.

## Maintaining this

- One doc per concern, named for the concern (`ROUTING.md`, not `NOTES.md`).
  When a new subsystem needs more explanation than a code comment can carry,
  that's a new file here, linked from the README, not a growing appendix on
  an existing doc about something else.
- These are written for a person about to run an experiment or make a design
  decision, not as API reference — code comments and `server/*/CLAUDE.md`
  cover that. If a doc here starts describing function signatures, that
  content probably belongs next to the code instead.
