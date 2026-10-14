# Performance

`npm run bench` measures how Fest scales and where its CPU goes, then writes a
self-contained HTML report. Reports worth keeping go in `docs/perf/`.

```bash
npm run bench                                  # the default ramp, ~10 minutes
npm run bench -- --quick                       # a ~1 minute smoke run
npm run bench -- --workers 1,4 --stages 100,400,1600 --stage-seconds 20
npm run bench -- --render docs/perf/<file>.json  # re-render a saved result
```

Run it on the Node that Fest ships on (`engines` in `package.json`). The report
warns when it was produced on anything older.

## What it does

A gateway's load is long streaming turns, all open at once. Each turn does a
synchronous SQLite read when it starts, and the usage it produces is written
later, in batches. A requests-per-second benchmark would miss most of that, so
the bench simulates developers rather than requests:

1. **A fixture database**, built with the real store modules. It holds one
   identity token per simulated developer, an owner with a live dashboard
   session, and weeks of synthetic history (300k rows by default, from the
   generator `fest seed` uses). An empty database flatters every dashboard
   query, and a slow dashboard query is the likeliest thing to stall a
   worker's streams.
2. **A fake upstream** (`tools/bench/upstream.ts`) in its own process. It speaks
   Anthropic-shaped SSE with a controlled turn shape: time to first byte,
   chunk count, chunk interval and chunk size. Each chunk carries the time it
   was sent.
3. **The real gateway**, started with `fest serve` and `FEST_WORKERS=<n>`.
   `tools/bench/probe.ts` is preloaded into every process through
   `NODE_OPTIONS`, so the primary and each worker sample themselves and the
   server carries no bench code.
4. **Load generators** (`tools/bench/load.ts`), several processes so the
   generator is never the bottleneck.
   - Each simulated developer has its own token on one keep-alive connection,
     as Claude Code does. `node:cluster` balances connections, so a developer
     is pinned to one worker, as a real one is.
   - Developers loop: a turn, then think time. The turn kinds are passthrough
     on their own subscription, a routed model on a server key, and
     `count_tokens`.
   - Dashboard pollers, signed in as the owner, cycle through the read
     endpoints. Live-feed subscribers stay on `/api/live`.
5. **A ramp through stages** of increasing developers, for each worker count.
   It runs once with no Fest at all, the generators talking straight to the
   upstream, which is the floor the bench itself contributes to every number.
6. **A drain, then SIGTERM.** The bench then checks that every completed turn
   reached the database. A mismatch fails the run with exit code 1, as does a
   gateway that does not exit 0.
7. **A separate profiled pass** at a constant load, for the single process and
   for the widest cluster, with `--cpu-prof` in every gateway process. It is
   separate because profiling inflates event-loop utilisation several-fold,
   and would corrupt the scaling numbers if it ran during them.

## The numbers

| metric | what it is | why it matters |
| --- | --- | --- |
| **chunk relay latency** | per chunk: when it reached the client, minus when the upstream sent it (the stamp inside the payload) | what a developer feels as a stuttering stream. It is the first number to rise when any event loop is blocked: a sync DB read, a slow dashboard aggregate, a lock wait. |
| **TTFB overhead** | time to first byte minus the upstream's fixed delay | reading the request body, identity lookup, routing and connecting upstream |
| **turns/s, open streams, chunks/s** | throughput | whether the gateway is keeping up at all |
| **dashboard p50/p99** | per read endpoint, against the fixture's history | dashboard reads share the event loop with streams |
| **live lag** | a row's arrival on `/api/live`, minus the end of its turn | the sink's flush interval, plus IPC to and from the primary |
| **ELU, event-loop delay, CPU, RSS** | per gateway process, sampled 4×/s | ELU near 100% means the process is saturated. Event-loop delay is how late everything on that process runs. |
| **sink queue** | `queued` from `/healthz` | the writer falling behind shows here before any record is dropped |
| **generator and upstream ELU** | the bench's own processes | above 90%, the numbers describe the bench rather than Fest, and the report says so |

A stage **holds** when chunk relay p99, TTFB overhead p99 and the error rate
are all within the SLO (defaults 50ms, 100ms and 0.5%; change them with
`--slo relay=…,ttfb=…,errors=…`). "Developers within SLO" is the last stage
held before the first one that fails.

Absolute numbers depend on the machine, and everything shares it: gateway,
generators and upstream. Compare reports from the same machine. For numbers
you mean to quote, use a quiet machine, or a VM with the gateway's cores to
itself.

## Hotspots

Each profiled process gets three views:

- **by area**: Fest by subsystem (`server/store`, `server/pipeline`, …), Node
  internals by module, dependencies by package, and GC.
- **Fest functions by inclusive time**: the entry points worth reading.
- **top functions by self time**: where the cycles actually burn.

With more than one worker, the primary is profiled separately. Its time is the
metering writer, the live-feed broadcast and IPC.

## Options

| flag | default | |
| --- | --- | --- |
| `--workers` | `1,2,4,8` (only those that leave 4 cores spare) | worker counts to compare |
| `--stages` | `25,50,100,200,400,800` | simulated developers per stage |
| `--stage-seconds` | `15` | per stage. The first quarter (at most 3s) is warm-up and excluded. |
| `--shape` | `ttfb=300,chunks=60,interval=50,chars=40` | the upstream's turn shape |
| `--body-kb` | `64` | request body size. Claude Code sends large contexts. |
| `--think-ms` | `1000` | between a developer's turns, ±50% |
| `--mix` | `sub=80,route=10,count=10` | turn kinds, by weight |
| `--dashboards`, `--live`, `--poll-ms` | `4`, `2`, `2000` | dashboard load alongside |
| `--history`, `--history-days` | `300000`, `28` | fixture size |
| `--gen-procs` | cores ÷ 4, at most 4 | load generator processes |
| `--no-baseline`, `--no-profile` | | skip the no-Fest run, or the profiled pass |
| `--out` | `docs/perf/<date>-<name>` | writes `.html` and `.json` |
| `--keep` | | keep the temp directory (gateway logs, probe samples, raw `.cpuprofile`s) |

CI runs `--quick` on every push. That only checks the harness still runs end
to end. Shared runners are too noisy for its numbers to gate anything.

## Findings

### 2026-10-14: Apple M5 Pro, 18 cores, Node 26.11.1, SQLite 3.53.4

These are the first runs of the harness, and they double as its validation.
Both runs used a 300k-row fixture and the default turn shape: a 64 KB body,
60 chunks over 3s, 1s think time. In every run, every completed turn was in
the database and the gateway exited 0.

[`perf/2026-10-14-proxy-only.html`](perf/2026-10-14-proxy-only.html) is the
relay with no dashboard load:

| workers | within SLO up to | open streams there | turns/s | relay p99 there | busiest worker ELU |
| --- | --- | --- | --- | --- | --- |
| 1 | 800 developers | 539 | 172 | 32ms | 54% (saturates by 2,400) |
| 2 | 1,600 | 1,082 | 340 | 4.3ms | 48% |
| 4 | 1,600 | 1,081 | 341 | 4.3ms | 32% |
| 8 | 1,600 | 1,083 | 339 | 4.3ms | 21% |

- **One process tops out near 800–1,600 concurrent developers.** At that load
  its CPU goes to socket writes (`writev`, about 40% of busy time) and to the
  batch writer's transaction. A second worker roughly doubles the headroom.
- **Fest adds about 1–3ms per chunk**, against a 0.1–0.3ms floor for the bench
  itself, and about 4ms to time to first byte at p50, with a 64 KB body.
- **Open question, 2,400 developers:** every worker count fails here, and more
  workers make it *worse* (relay p50 44ms with 2 workers, 185ms with 8).
  Meanwhile every worker's event loop is healthy: about 2ms delay at under 60%
  utilisation. The bottleneck is outside Fest's JavaScript.
  - Ruled out: local port exhaustion (no `TIME_WAIT` build-up, and upstream
    connections are reused), and the bench processes (the same load without
    Fest holds at 1.5ms p99).
  - Left: kernel networking with about 10k loopback sockets and 14 busy
    processes on one machine.
  - Re-run on Linux, with the generators on another host, before reading this
    as a Fest limit.

[`perf/2026-10-14-ramp.html`](perf/2026-10-14-ramp.html) is the same ramp to
800 developers, with 4 dashboard pollers and 2 live-feed subscribers:

- **No configuration meets the SLO at any stage, because of dashboard reads.**
  A 30-day `/api/overview` takes 450ms–1.5s against 300k rows, synchronously,
  on the event loop of whichever worker serves it. Every stream on that worker
  stalls for as long, so relay p99 goes to 200–1,400ms even at 25 developers.
  Relay p50 stays at 1–3ms, and throughput matches the baseline.
- **The profile names the queries.** `handleApi` is 83% of the busy worker's
  CPU, mostly `usageByClient`, `usageByCredentialOrigin`, `runTotals` and
  `usageByUser` in `server/store/queries.ts`.
- **More workers contain the stall but don't remove it.** With 8 workers, the
  workers serving no dashboard stay at about 1ms event-loop delay.
- **This is the first follow-up to do:** move dashboard reads off the request
  event loop (a worker thread, or a dedicated read process), and/or make those
  aggregates cheaper. The identity lookup (`resolveToken`) is about 1% of a
  worker's CPU at 1,600 developers. Caching it is not urgent.
