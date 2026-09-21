# The version canary

Run this before rolling a new Claude Code release to the team.

```bash
npm run canary
```

Exit 0 is a green light. Exit 1 means **do not roll out**. Exit 2 means the run
proved nothing and needs attention before it means anything.

## Why it exists

Fest's whole proposition — each developer's own subscription, relayed, with
nobody pooling a key — rests on there being no host check in Claude Code's
inference client. That is an absence, not a feature. Nobody at Anthropic
promised it, and no changelog will mention it going away.

The failure mode is silent. If a release starts demoting to key auth at a custom
base URL, nothing breaks: requests still succeed, the dashboard still fills in,
and the entire team is quietly billed to whatever credential the gateway holds
instead of their own subscription. You find out at the invoice.

So the canary re-runs the two Phase 0 experiments the product depends on:

| Run | Question | Failing means |
| --- | --- | --- |
| (a) | Does the subscription bearer still reach a custom base URL? | The client changed. Pin the team to the last PASS. |
| (e) | Does Anthropic still accept that bearer when Fest relays it? | The server changed. Pass-through may be over; see the decision rule in `PHASE0.md`. |

It drives the real `claude` binary against the real Phase 0 capture server. A
canary that re-implements the checks tests the reimplementation, not the client.

## Reading the result

**PASS** — both gates held. The version is recorded in `canary-history.jsonl`,
which is the record a rollout decision cites.

**FAIL** — a gate broke, and the checks say which half. `a.*` red is the client;
`e.*` red is Anthropic. Pin developers to the last version recorded as PASS and
localise the change by hand from `PHASE0.md`, altering one thing at a time.

**INCONCLUSIVE** — the run could not measure what it claims to measure: no
binary, not a subscription login, a settings layer that would demote the client,
or a model this account cannot reach. Nothing was proven either way. This case
is deliberately loud rather than absent, because the expensive mistake is a run
that quietly measured nothing and printed green.

**PARTIAL** — `--observe-only` ran (a) and skipped (e). Half the gate is the half
that involves Anthropic, so this is never reported as a pass.

## What it protects against measuring the wrong thing

Local configuration can invalidate a run in ways that look exactly like the
regression being hunted. So, before anything is measured:

- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and the Bedrock/Vertex switches are
  cleared for the child, as `PHASE0.md` does with `env -u`.
- Every settings layer is searched for `apiKeyHelper` or a key in its `env`
  block. These cannot be cleared from outside — the client reads them itself —
  so finding one stops the run. Keys are reported by name; values are never read.
- `~/.claude.json` is checked for an OAuth login. Without that, run (a) reporting
  an API key is ambiguous: an API-key login looks identical to the regression.
- The model is **pinned** (`CANARY_MODEL`, default `haiku`) rather than
  inherited. The first real run of this canary went red because a settings file
  selected `claude-deepseek-v4` — a model that exists only behind Fest's routing
  table — and Anthropic answered 404. A 404 for the model is now inconclusive,
  not a failure: the bearer was read, the model was absent, and that says nothing
  about pass-through.

## Cost and privacy

Run (e) sends one real prompt on the operator's own subscription — a few tokens,
by design. Credentials are never written: the capture server reduces each to a
kind label and a fingerprint, and the history file holds only a version, a
verdict and check outcomes.

## Options

```
npm run canary                    both runs
npm run canary -- --observe-only  run (a) only; no upstream traffic
npm run canary -- --json          machine-readable on stdout, verdict on stderr
```

`CANARY_MODEL` pins the model. `CANARY_TIMEOUT_MS` bounds one client run.
`CANARY_HISTORY` and `CANARY_LOG_DIR` relocate the outputs.

It is not a CI job: CI has no subscription to relay. It belongs on the machine of
whoever approves a version bump, or on a laptop cron that mails its stderr.
