/**
 * `npm run bench` — how Fest scales, and where its CPU goes.
 *
 * For each worker count (and once with no Fest at all, as the measurement
 * floor) it:
 *   1. copies one prebuilt fixture database (`fixture.ts`) — weeks of history,
 *      one identity token per simulated developer, an owner session;
 *   2. boots the REAL gateway (`fest serve`) with `FEST_WORKERS=<n>`, pointed at
 *      the fake upstream (`upstream.ts`), with `probe.ts` preloaded and
 *      `--cpu-prof` on in every process;
 *   3. ramps the load generators (`load.ts`) through the stages — N simulated
 *      developers each, plus dashboard pollers and live-feed subscribers;
 *   4. drains, stops the gateway with SIGTERM (so every process writes its
 *      profile), and checks that every completed turn reached the database;
 *   5. summarises each stage against the SLO, and each process's profile.
 *
 * Then it writes a JSON result and a self-contained HTML report (`report.ts`).
 *
 *   npm run bench                                  # the default ramp
 *   npm run bench -- --quick                       # a ~30s smoke run
 *   npm run bench -- --workers 1,4 --stages 100,400,1600 --stage-seconds 20
 *   npm run bench -- --render docs/perf/x.json     # re-render a saved result
 *
 * See docs/PERF.md for what each number means and how to read a report.
 */

import { fork, spawn, execFileSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, createWriteStream, existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { buildFixture, writeRoutes } from "./fixture.ts";
import { emptyHist, merge, mergeAll, summarize, type Hist, type Summary } from "./hist.ts";
import type { LoadInit, Tick } from "./load.ts";
import { summarizeProfileFile, type ProfileSummary } from "./profile.ts";
import { renderReport } from "./report.ts";
import type { TurnShape } from "./upstream.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const HERE = import.meta.dirname;

// ── Options ────────────────────────────────────────────────────────────────

export interface BenchParams {
  readonly name: string;
  readonly workers: readonly number[];
  readonly baseline: boolean;
  readonly stages: readonly number[];
  readonly stageSeconds: number;
  readonly warmupSeconds: number;
  readonly historyRows: number;
  readonly historyDays: number;
  readonly bodyKb: number;
  readonly thinkMs: number;
  readonly mix: { readonly sub: number; readonly route: number; readonly count: number };
  readonly dashboards: number;
  readonly live: number;
  readonly pollMs: number;
  readonly genProcs: number;
  readonly shape: TurnShape;
  readonly profile: boolean;
  readonly slo: { readonly relayP99Ms: number; readonly ttfbOverheadP99Ms: number; readonly errorRate: number };
}

function kv(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of raw.split(",")) {
    const [k, v] = part.split("=");
    if (k === undefined || v === undefined || !Number.isFinite(Number(v))) throw new Error(`bad key=value list: ${raw}`);
    out[k.trim()] = Number(v);
  }
  return out;
}

const list = (raw: string): number[] => raw.split(",").map((s) => {
  const n = Number(s.trim());
  if (!Number.isInteger(n) || n < 0) throw new Error(`bad number list: ${raw}`);
  return n;
});

function parseParams(argv: string[]): { params: BenchParams; out: string | null; render: string | null; keep: boolean } {
  const { values } = parseArgs({
    args: argv,
    options: {
      quick: { type: "boolean", default: false },
      name: { type: "string" },
      workers: { type: "string" },
      baseline: { type: "boolean", default: true },
      "no-baseline": { type: "boolean", default: false },
      stages: { type: "string" },
      "stage-seconds": { type: "string" },
      history: { type: "string" },
      "history-days": { type: "string" },
      "body-kb": { type: "string" },
      "think-ms": { type: "string" },
      mix: { type: "string" },
      dashboards: { type: "string" },
      live: { type: "string" },
      "poll-ms": { type: "string" },
      "gen-procs": { type: "string" },
      shape: { type: "string" },
      "no-profile": { type: "boolean", default: false },
      slo: { type: "string" },
      out: { type: "string" },
      render: { type: "string" },
      keep: { type: "boolean", default: false },
    },
    strict: true,
  });
  const quick = values.quick === true;
  const cores = os.availableParallelism();
  // Leave cores for the generators and the upstream, which share the machine.
  const defaultWorkers = [1, 2, 4, 8].filter((w) => w === 1 || w <= Math.max(1, cores - 4));
  const shape = { ttfb: 300, chunks: 60, interval: 50, chars: 40, ...(values.shape ? kv(values.shape) : {}) };
  const mix = { sub: 80, route: 10, count: 10, ...(values.mix ? kv(values.mix) : {}) };
  const slo = { relay: 50, ttfb: 100, errors: 0.5, ...(values.slo ? kv(values.slo) : {}) };
  const stageSeconds = Number(values["stage-seconds"] ?? (quick ? 4 : 15));
  const params: BenchParams = {
    name: values.name ?? (quick ? "quick" : "ramp"),
    workers: values.workers ? list(values.workers) : quick ? [1, 2] : defaultWorkers,
    baseline: values["no-baseline"] !== true,
    stages: values.stages ? list(values.stages) : quick ? [10, 40] : [25, 50, 100, 200, 400, 800],
    stageSeconds,
    warmupSeconds: Math.min(3, Math.floor(stageSeconds / 4)),
    historyRows: Number(values.history ?? (quick ? 5_000 : 300_000)),
    historyDays: Number(values["history-days"] ?? 28),
    bodyKb: Number(values["body-kb"] ?? 64),
    thinkMs: Number(values["think-ms"] ?? 1000),
    mix,
    dashboards: Number(values.dashboards ?? (quick ? 1 : 4)),
    live: Number(values.live ?? 2),
    pollMs: Number(values["poll-ms"] ?? 2000),
    genProcs: Number(values["gen-procs"] ?? (quick ? 1 : Math.min(4, Math.max(1, Math.floor(cores / 4))))),
    shape: { ttfbMs: shape.ttfb, chunks: shape.chunks, chunkIntervalMs: shape.interval, chunkChars: shape.chars },
    profile: values["no-profile"] !== true,
    slo: { relayP99Ms: slo.relay, ttfbOverheadP99Ms: slo.ttfb, errorRate: slo.errors / 100 },
  };
  return { params, out: values.out ?? null, render: values.render ?? null, keep: values.keep === true };
}

// ── Result shapes (the JSON the report renders) ──────────────────────────────

export interface ProcSample {
  readonly sec: number;
  readonly role: string;
  readonly elu: number;
  readonly eldP99: number | null;
  readonly eldMax: number | null;
  readonly cpu: number;
  readonly rss: number;
  readonly gcMs: number;
}

export interface TimelinePoint {
  readonly sec: number;
  readonly stage: number;
  readonly developers: number;
  readonly streams: number;
  readonly turnsPerSec: number;
  readonly errors: number;
  readonly relayP50: number | null;
  readonly relayP99: number | null;
  readonly ttfbP99: number | null;
  readonly dashboardP99: number | null;
  readonly sinkQueued: number | null;
  readonly genElu: number;
  readonly upstreamElu: number | null;
}

export interface StageResult {
  readonly stage: number;
  readonly developers: number;
  readonly seconds: number;
  readonly turnsPerSec: number;
  readonly countPerSec: number;
  readonly streamsAvg: number;
  readonly chunksPerSec: number;
  readonly ttfb: Summary;
  readonly ttfbOverheadP50: number | null;
  readonly ttfbOverheadP99: number | null;
  readonly relay: Summary;
  readonly countLatency: Summary;
  readonly errorRate: number;
  readonly errors: Record<string, number>;
  readonly dashboard: Record<string, Summary>;
  readonly liveLag: Summary;
  readonly liveRows: number;
  /** Per gateway process: mean ELU, worst event-loop delay p99, mean CPU (cores). */
  readonly procs: Record<string, { elu: number; eldP99: number | null; cpu: number; rssMb: number }>;
  readonly genEluMax: number;
  readonly upstreamElu: number | null;
  readonly held: boolean;
  readonly failed: readonly string[];
}

export interface RunResult {
  readonly label: string;
  /** 0 for the no-Fest baseline. */
  readonly workers: number;
  readonly stages: readonly StageResult[];
  readonly timeline: readonly TimelinePoint[];
  readonly procTimeline: readonly ProcSample[];
  /**
   * From a separate profiled pass at one constant load (`profiledAt`
   * developers): `--cpu-prof` inflates event-loop utilisation several-fold, so
   * profiling is kept out of the scaling numbers above.
   */
  readonly profiles: ReadonlyArray<{ role: string; pid: number; summary: ProfileSummary }>;
  readonly profiledAt: number | null;
  readonly persisted: { ok: number; rows: number; turnsOk: number; match: boolean } | null;
  readonly maxHeld: number | null;
  readonly gatewayExit: number | null;
  readonly warnings: readonly string[];
}

export interface BenchResult {
  readonly meta: {
    readonly startedAt: string;
    readonly durationS: number;
    readonly git: string;
    readonly dirty: boolean;
    readonly festVersion: string;
    readonly node: string;
    readonly sqlite: string;
    readonly os: string;
    readonly cpu: string;
    readonly cores: number;
    readonly memGb: number;
    readonly historyRows: number;
    readonly warnings?: readonly string[];
  };
  readonly params: BenchParams;
  readonly runs: readonly RunResult[];
}

// ── Plumbing ───────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const say = (s: string): void => void process.stderr.write(`bench: ${s}\n`);

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function getJson(port: number, path: string): Promise<unknown> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path, agent: false, timeout: 2000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

function once<T>(child: ChildProcess, pred: (m: any) => m is T, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", on);
      reject(new Error(`timed out waiting for ${what}`));
    }, ms);
    const on = (m: unknown): void => {
      if (pred(m)) {
        clearTimeout(timer);
        child.off("message", on);
        resolve(m);
      }
    };
    child.on("message", on);
  });
}
const isT = <K extends string>(t: K) => (m: any): m is { t: K } & Record<string, any> =>
  typeof m === "object" && m !== null && m.t === t;

function git(): { sha: string; dirty: boolean } {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
    return { sha, dirty };
  } catch {
    return { sha: "unknown", dirty: false };
  }
}

function avg(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ── One run ─────────────────────────────────────────────────────────────────

interface Upstream {
  readonly child: ChildProcess;
  readonly port: number;
  stats(): Promise<{ elu: number; streams: number; requests: number } | null>;
}

async function startUpstreamProc(shape: TurnShape): Promise<Upstream> {
  const child = fork(join(HERE, "upstream.ts"), [JSON.stringify(shape)], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const { port } = await once(child, isT("listening"), 10_000, "the fake upstream");
  return {
    child,
    port,
    stats: async () => {
      child.send({ t: "stats" });
      return once(child, isT("stats"), 2000, "upstream stats").then(
        (m) => ({ elu: m.elu as number, streams: m.streams as number, requests: m.requests as number }),
        () => null,
      );
    },
  };
}

async function startGateway(opts: {
  workers: number;
  dir: string;
  dbPath: string;
  routesPath: string;
  upstreamPort: number;
  profile: boolean;
}): Promise<{ proc: ChildProcess; port: number; exited: Promise<number | null>; logPath: string }> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FEST_")));
  const nodeOptions = [
    `--import=${pathToFileURL(join(HERE, "probe.ts")).href}`,
    ...(opts.profile ? ["--cpu-prof", `--cpu-prof-dir=${join(opts.dir, "prof")}`] : []),
  ];
  Object.assign(env, {
    FEST_WORKERS: String(opts.workers),
    FEST_HOST: "127.0.0.1",
    FEST_PORT: String(port),
    FEST_DB: opts.dbPath,
    FEST_USAGE_LOG: join(opts.dir, "usage.jsonl"),
    FEST_UPSTREAM_BASE_URL: `http://127.0.0.1:${opts.upstreamPort}`,
    FEST_ROUTES: opts.routesPath,
    FEST_PRICING_REFRESH: "off",
    FEST_BENCH_PROBE_DIR: join(opts.dir, "probe"),
    BENCH_ROUTE_KEY: "bench-route-key-not-a-secret",
    NODE_OPTIONS: [process.env.NODE_OPTIONS ?? "", ...nodeOptions].join(" ").trim(),
  });
  const logPath = join(opts.dir, "gateway.log");
  const log = createWriteStream(logPath);
  const proc = spawn(process.execPath, [join(ROOT, "server", "bin", "fest.ts"), "serve"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.pipe(log);
  proc.stderr?.pipe(log);
  const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));

  const want = Math.max(1, opts.workers);
  const deadline = Date.now() + 30_000;
  const seen = new Set<string>();
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    const h = (await getJson(port, "/healthz")) as { ok?: boolean; worker?: number | null } | null;
    if (h?.ok === true) seen.add(String(h.worker));
    if (seen.size >= want) return { proc, port, exited, logPath };
    await sleep(100);
  }
  proc.kill("SIGKILL");
  throw new Error(`gateway did not come up with ${want} worker(s); see ${logPath}:\n${readFileSync(logPath, "utf8").slice(-2000)}`);
}

function readProbes(dir: string, t0: number): { samples: ProcSample[]; roles: Map<number, string> } {
  const samples: ProcSample[] = [];
  const roles = new Map<number, string>();
  const probeDir = join(dir, "probe");
  if (!existsSync(probeDir)) return { samples, roles };
  for (const f of readdirSync(probeDir)) {
    for (const line of readFileSync(join(probeDir, f), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const s = JSON.parse(line) as { t: number; pid: number; role: string; elu: number; eldP99: number | null; eldMax: number | null; cpu: number; rss: number; gcMs: number };
      roles.set(s.pid, s.role);
      samples.push({ sec: (s.t - t0) / 1000, role: s.role, elu: s.elu, eldP99: s.eldP99, eldMax: s.eldMax, cpu: s.cpu, rss: s.rss, gcMs: s.gcMs });
    }
  }
  // A respawned worker reuses its id under a new pid; the role name stays.
  return { samples: samples.sort((a, b) => a.sec - b.sec), roles };
}

/**
 * The probe samples 4×/s; the report plots per second. One point per process
 * per second (mean ELU/CPU, worst delay, peak memory) keeps the saved JSON a
 * fraction of the size. Idempotent, so `--render` can apply it to old results.
 */
export function perSecond(samples: readonly ProcSample[]): ProcSample[] {
  const groups = new Map<string, ProcSample[]>();
  for (const s of samples) {
    const key = `${s.role}|${Math.round(s.sec)}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const worst = (xs: Array<number | null>): number | null => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length === 0 ? null : Math.max(...v);
  };
  const r3 = (x: number): number => Math.round(x * 1000) / 1000;
  return [...groups.values()]
    .map((g) => ({
      sec: Math.round(g[0]!.sec),
      role: g[0]!.role,
      elu: r3(avg(g.map((s) => s.elu))),
      eldP99: worst(g.map((s) => s.eldP99)),
      eldMax: worst(g.map((s) => s.eldMax)),
      cpu: r3(avg(g.map((s) => s.cpu))),
      rss: Math.max(...g.map((s) => s.rss)),
      gcMs: r3(g.reduce((a, s) => a + s.gcMs, 0)),
    }))
    .sort((a, b) => a.sec - b.sec);
}

function roleLabel(role: string, workers: number): string {
  if (role === "main") return workers > 1 ? "primary" : "gateway";
  return role;
}

async function runOne(
  label: string,
  workers: number,
  p: BenchParams,
  ctx: { tmp: string; templateDb: string; tokens: readonly string[]; cookie: string; upstream: Upstream },
  mode: { readonly stages: readonly number[]; readonly stageSeconds: number; readonly profile: boolean },
): Promise<RunResult> {
  const warnings: string[] = [];
  const dir = join(ctx.tmp, `run-${workers}${mode.profile ? "-prof" : ""}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "fest.db");
  copyFileSync(ctx.templateDb, dbPath);
  const routesPath = writeRoutes(dir, `http://127.0.0.1:${ctx.upstream.port}`);

  const direct = workers === 0;
  let gw: Awaited<ReturnType<typeof startGateway>> | null = null;
  let targetPort = ctx.upstream.port;
  if (!direct) {
    gw = await startGateway({ workers, dir, dbPath, routesPath, upstreamPort: ctx.upstream.port, profile: mode.profile });
    targetPort = gw.port;
  }
  const t0 = Date.now();
  const startedAtMs = Date.now();

  // Generators.
  const gens: ChildProcess[] = [];
  const ticks: Tick[] = [];
  for (let g = 0; g < p.genProcs; g += 1) {
    const child = fork(join(HERE, "load.ts"), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    child.on("message", (m: unknown) => {
      if (isT("tick")(m)) ticks.push(m as unknown as Tick);
    });
    const init: LoadInit = {
      t: "init",
      port: targetPort,
      tokens: ctx.tokens.filter((_, i) => i % p.genProcs === g),
      cookie: ctx.cookie,
      mix: direct ? { ...p.mix, route: 0 } : p.mix,
      bodyKb: p.bodyKb,
      thinkMs: p.thinkMs,
      pollMs: p.pollMs,
    };
    child.send(init);
    await once(child, isT("ready"), 10_000, "a load generator");
    gens.push(child);
  }
  const share = (n: number, g: number): number => Math.floor(n / p.genProcs) + (g < n % p.genProcs ? 1 : 0);

  // Sink and upstream, once a second.
  const sinkBySec = new Map<number, number>();
  const upstreamBySec = new Map<number, number>();
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const sec = Math.round((Date.now() - t0) / 1000);
      if (gw !== null) {
        const h = (await getJson(gw.port, "/healthz")) as { sink?: { queued?: number } } | null;
        if (typeof h?.sink?.queued === "number") sinkBySec.set(sec, h.sink.queued);
      }
      const u = await ctx.upstream.stats();
      if (u !== null) upstreamBySec.set(sec, u.elu);
      await sleep(1000);
    }
  })();

  const stageWindows: Array<{ stage: number; from: number; to: number }> = [];
  for (let s = 0; s < mode.stages.length; s += 1) {
    const developers = mode.stages[s]!;
    say(`${label}: stage ${s + 1}/${mode.stages.length} — ${developers} developers${mode.profile ? " (profiling)" : ""}`);
    const from = Date.now();
    gens.forEach((g, i) =>
      g.send({
        t: "stage",
        stage: s,
        developers: share(developers, i),
        dashboards: direct ? 0 : share(p.dashboards, i),
        live: direct ? 0 : share(p.live, i),
      }),
    );
    await sleep(mode.stageSeconds * 1000);
    stageWindows.push({ stage: s, from, to: Date.now() });
  }

  say(`${label}: draining`);
  await Promise.all(gens.map((g) => (g.send({ t: "drain" }), once(g, isT("drained"), 240_000, "generators to drain")))).catch(
    (err: Error) => warnings.push(err.message),
  );
  polling = false;
  await poller;
  for (const g of gens) g.send({ t: "stop" });

  // Stop the gateway the way an orchestrator would, so every process writes
  // its profile and the sink flushes.
  let gatewayExit: number | null = null;
  if (gw !== null) {
    gw.proc.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    gatewayExit = await Promise.race([gw.exited, new Promise<number>((r) => (timer = setTimeout(() => r(-1), 30_000)))]);
    clearTimeout(timer);
    if (gatewayExit === -1) {
      warnings.push("gateway did not exit within 30s of SIGTERM; killed");
      gw.proc.kill("SIGKILL");
    } else if (gatewayExit !== 0) {
      warnings.push(`gateway exited ${gatewayExit}; see its log`);
    }
  }

  // ── Fold ticks into stages and a timeline ──
  const bySec = new Map<number, Tick[]>();
  for (const t of ticks) {
    const sec = Math.round((t.at - t0) / 1000);
    bySec.set(sec, [...(bySec.get(sec) ?? []), t]);
  }
  const timeline: TimelinePoint[] = [...bySec.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sec, ts]) => {
      const relay = mergeAll(ts.map((t) => t.relay));
      const ttfb = mergeAll(ts.map((t) => t.ttfb));
      const dash = mergeAll(ts.flatMap((t) => Object.values(t.dashboard)));
      return {
        sec,
        stage: Math.max(...ts.map((t) => t.stage)),
        developers: ts.reduce((a, t) => a + t.developers, 0),
        streams: ts.reduce((a, t) => a + t.streams, 0),
        turnsPerSec: ts.reduce((a, t) => a + t.turnsOk, 0),
        errors: ts.reduce((a, t) => a + t.turnsErr, 0),
        relayP50: summarize(relay).p50,
        relayP99: summarize(relay).p99,
        ttfbP99: summarize(ttfb).p99,
        dashboardP99: summarize(dash).p99,
        sinkQueued: sinkBySec.get(sec) ?? null,
        genElu: Math.max(...ts.map((t) => t.elu)),
        upstreamElu: upstreamBySec.get(sec) ?? null,
      };
    });

  const { samples: procTimeline, roles } = readProbes(dir, t0);
  const labelled = procTimeline.map((s) => ({ ...s, role: roleLabel(s.role, workers) }));

  const stages: StageResult[] = stageWindows.map((w) => {
    const lo = (w.from - t0) / 1000 + p.warmupSeconds;
    const hi = (w.to - t0) / 1000;
    const inWin = ticks.filter((t) => t.stage === w.stage && (t.at - t0) / 1000 > lo && (t.at - t0) / 1000 <= hi + 0.5);
    const seconds = Math.max(1, new Set(inWin.map((t) => Math.round((t.at - t0) / 1000))).size);
    const relayH = mergeAll(inWin.map((t) => t.relay));
    const ttfbH = mergeAll(inWin.map((t) => t.ttfb));
    const dashboard: Record<string, Hist> = {};
    for (const t of inWin) for (const [k, h] of Object.entries(t.dashboard)) merge((dashboard[k] ??= emptyHist()), h);
    const errors: Record<string, number> = {};
    for (const t of inWin) for (const [k, n] of Object.entries(t.errors)) errors[k] = (errors[k] ?? 0) + n;
    const ok = inWin.reduce((a, t) => a + t.turnsOk + t.countOk, 0);
    const err = inWin.reduce((a, t) => a + t.turnsErr, 0);
    const ttfb = summarize(ttfbH);
    const procs: StageResult["procs"] = {};
    const winSamples = labelled.filter((s) => s.sec > lo && s.sec <= hi);
    for (const role of new Set(winSamples.map((s) => s.role))) {
      const rs = winSamples.filter((s) => s.role === role);
      const eld = rs.map((s) => s.eldP99).filter((x): x is number => x !== null);
      procs[role] = {
        elu: avg(rs.map((s) => s.elu)),
        eldP99: eld.length === 0 ? null : Math.max(...eld),
        cpu: avg(rs.map((s) => s.cpu)),
        rssMb: Math.max(...rs.map((s) => s.rss)) / 1048576,
      };
    }
    const ups = [...upstreamBySec.entries()].filter(([s]) => s > lo && s <= hi).map(([, e]) => e);
    const sloFails: string[] = [];
    const relay = summarize(relayH);
    const overheadP99 = ttfb.p99 === null ? null : Math.max(0, ttfb.p99 - p.shape.ttfbMs);
    const errorRate = ok + err === 0 ? 0 : err / (ok + err);
    if (relay.p99 !== null && relay.p99 > p.slo.relayP99Ms) sloFails.push(`chunk relay p99 ${relay.p99.toFixed(1)}ms > ${p.slo.relayP99Ms}ms`);
    if (overheadP99 !== null && overheadP99 > p.slo.ttfbOverheadP99Ms) sloFails.push(`TTFB overhead p99 ${overheadP99.toFixed(0)}ms > ${p.slo.ttfbOverheadP99Ms}ms`);
    if (errorRate > p.slo.errorRate) sloFails.push(`errors ${(errorRate * 100).toFixed(2)}% > ${(p.slo.errorRate * 100).toFixed(2)}%`);
    if (relay.n === 0) sloFails.push("no completed chunks");
    return {
      stage: w.stage,
      developers: mode.stages[w.stage]!,
      seconds,
      turnsPerSec: inWin.reduce((a, t) => a + t.turnsOk, 0) / seconds,
      countPerSec: inWin.reduce((a, t) => a + t.countOk, 0) / seconds,
      streamsAvg: avg(inWin.map((t) => t.streams)) * p.genProcs,
      chunksPerSec: relayH.n / seconds,
      ttfb,
      ttfbOverheadP50: ttfb.p50 === null ? null : Math.max(0, ttfb.p50 - p.shape.ttfbMs),
      ttfbOverheadP99: overheadP99,
      relay,
      countLatency: summarize(mergeAll(inWin.map((t) => t.countLatency))),
      errorRate,
      errors,
      dashboard: Object.fromEntries(Object.entries(dashboard).map(([k, h]) => [k, summarize(h)])),
      liveLag: summarize(mergeAll(inWin.map((t) => t.liveLag))),
      liveRows: inWin.reduce((a, t) => a + t.liveRows, 0),
      procs,
      genEluMax: Math.max(0, ...inWin.map((t) => t.elu)),
      upstreamElu: ups.length === 0 ? null : avg(ups),
      held: sloFails.length === 0,
      failed: sloFails,
    };
  });

  for (const s of stages) {
    if (s.genEluMax > 0.9) warnings.push(`stage ${s.developers}: a load generator hit ${(s.genEluMax * 100).toFixed(0)}% ELU — add --gen-procs; numbers past here describe the bench`);
    if (s.upstreamElu !== null && s.upstreamElu > 0.9) warnings.push(`stage ${s.developers}: the fake upstream hit ${(s.upstreamElu * 100).toFixed(0)}% ELU — numbers past here describe the bench`);
  }

  let maxHeld: number | null = null;
  for (const s of stages) {
    if (!s.held) break;
    maxHeld = s.developers;
  }

  // ── Did every completed turn reach the database? ──
  let persisted: RunResult["persisted"] = null;
  if (!direct) {
    const turnsOk = ticks.reduce((a, t) => a + t.turnsOk, 0);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare(`SELECT COUNT(*) AS rows, SUM(status = 'ok') AS ok FROM requests WHERE started_at >= ?`)
        .get(startedAtMs) as { rows: number; ok: number | null };
      persisted = { rows: row.rows, ok: row.ok ?? 0, turnsOk, match: (row.ok ?? 0) === turnsOk };
      if (!persisted.match) warnings.push(`persisted ${persisted.ok} ok rows for ${turnsOk} completed turns`);
    } finally {
      db.close();
    }
  }

  // ── Profiles ──
  const profiles: RunResult["profiles"][number][] = [];
  const profDir = join(dir, "prof");
  if (!direct && mode.profile && existsSync(profDir)) {
    for (const f of readdirSync(profDir).filter((f) => f.endsWith(".cpuprofile"))) {
      // CPU.<date>.<time>.<pid>.<tid>.<seq>.cpuprofile
      const pid = Number(f.split(".")[3]);
      const role = roleLabel(roles.get(pid) ?? "unknown", workers);
      try {
        profiles.push({ role, pid, summary: summarizeProfileFile(join(profDir, f), ROOT) });
      } catch (err) {
        warnings.push(`could not read profile ${f}: ${String(err)}`);
      }
    }
    profiles.sort((a, b) => a.role.localeCompare(b.role, "en", { numeric: true }));
  }

  return {
    label,
    workers,
    stages,
    timeline,
    procTimeline: perSecond(labelled),
    profiles,
    profiledAt: mode.profile ? (mode.stages[0] ?? null) : null,
    persisted,
    maxHeld,
    gatewayExit,
    warnings,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { params: p, out, render, keep } = parseParams(process.argv.slice(2));

  if (render !== null) {
    const loaded = JSON.parse(readFileSync(render, "utf8")) as BenchResult;
    const result: BenchResult = { ...loaded, runs: loaded.runs.map((r) => ({ ...r, procTimeline: perSecond(r.procTimeline) })) };
    writeFileSync(render, JSON.stringify(result));
    const html = render.replace(/\.json$/, "") + ".html";
    writeFileSync(html, renderReport(result));
    say(`wrote ${html}`);
    return;
  }

  const began = Date.now();
  const engines = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { engines?: { node?: string } }).engines?.node ?? "";
  const floor = Number(/(\d+)/.exec(engines)?.[1] ?? 0);
  const globalWarnings: string[] = [];
  if (Number(process.versions.node.split(".")[0]) < floor) {
    globalWarnings.push(`ran on Node ${process.version}, below package.json's engines (${engines}): not the runtime Fest ships on`);
    say(globalWarnings.at(-1)!);
  }
  const tmp = mkdtempSync(join(os.tmpdir(), "fest-bench-"));
  const maxDevs = Math.max(...p.stages);
  say(`fixture: ${maxDevs} developers, ${p.historyRows.toLocaleString()} history rows over ${p.historyDays} days`);
  const fixture = buildFixture(tmp, { developers: maxDevs, historyRows: p.historyRows, historyDays: p.historyDays });

  const upstream = await startUpstreamProc(p.shape);
  const runs: RunResult[] = [];
  try {
    const plan: Array<[string, number]> = [
      ...(p.baseline ? ([["direct (no Fest)", 0]] as Array<[string, number]>) : []),
      ...p.workers.map((w): [string, number] => [w === 1 ? "1 worker" : `${w} workers`, w]),
    ];
    const ctx = { tmp, templateDb: fixture.dbPath, tokens: fixture.tokens, cookie: fixture.cookie, upstream };
    for (const [label, workers] of plan) {
      const r = await runOne(label, workers, p, ctx, { stages: p.stages, stageSeconds: p.stageSeconds, profile: false });
      runs.push(r);
      say(`${label}: held up to ${r.maxHeld ?? "none"} developers${r.warnings.length ? ` (${r.warnings.length} warning(s))` : ""}`);
    }
    // Hotspots: one profiled pass for the single process and one for the
    // widest cluster, each at the heaviest load that configuration held (or the
    // heaviest stage, if none held) — the load where its CPU is worth
    // understanding.
    if (p.profile) {
      const targets = [...new Set([Math.min(...p.workers), Math.max(...p.workers)])];
      for (const w of targets) {
        const i = runs.findIndex((r) => r.workers === w);
        if (i === -1) continue;
        const at = runs[i]!.maxHeld ?? Math.max(...p.stages);
        const prof = await runOne(runs[i]!.label, w, p, ctx, { stages: [at], stageSeconds: Math.max(p.stageSeconds, 10), profile: true });
        runs[i] = {
          ...runs[i]!,
          profiles: prof.profiles,
          profiledAt: at,
          warnings: [...runs[i]!.warnings, ...prof.warnings.map((x) => `profiled pass: ${x}`)],
        };
      }
    }
  } finally {
    upstream.child.send({ t: "stop" });
    if (!keep) rmSync(tmp, { recursive: true, force: true });
    else say(`kept ${tmp}`);
  }

  const g = git();
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  const result: BenchResult = {
    meta: {
      startedAt: new Date(began).toISOString(),
      durationS: Math.round((Date.now() - began) / 1000),
      git: g.sha,
      dirty: g.dirty,
      festVersion: pkg.version,
      node: process.version,
      sqlite: process.versions.sqlite ?? "?",
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? "?",
      cores: os.availableParallelism(),
      memGb: Math.round(os.totalmem() / 1024 ** 3),
      historyRows: fixture.historyRows,
      warnings: globalWarnings,
    },
    params: p,
    runs,
  };

  const base = out ?? join(ROOT, "docs", "perf", `${new Date(began).toISOString().slice(0, 10)}-${p.name}`);
  const stem = base.replace(/\.(html|json)$/, "");
  mkdirSync(dirname(stem), { recursive: true });
  writeFileSync(`${stem}.json`, JSON.stringify(result));
  writeFileSync(`${stem}.html`, renderReport(result));
  say(`wrote ${stem}.html (and .json) in ${result.meta.durationS}s`);
  const bad = runs.flatMap((r) => (r.persisted !== null && !r.persisted.match) || (r.gatewayExit ?? 0) !== 0 ? [r.label] : []);
  if (bad.length > 0) {
    say(`correctness problems in: ${bad.join(", ")}`);
    process.exitCode = 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
