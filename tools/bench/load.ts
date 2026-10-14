/**
 * The bench's load generator: simulated developers driving a real Fest.
 *
 * Forked by `run.ts`, usually several times, so the generator is never the
 * bottleneck it is measuring; each process reports its own event-loop
 * utilisation, and the report flags any that saturate.
 *
 * A simulated developer is one identity token on ONE keep-alive connection
 * (`maxSockets: 1`), because that is what Claude Code does — and it matters:
 * `node:cluster` balances connections, not requests, so a developer is pinned to
 * one worker exactly as a real one is. Each loops: a turn, then think time.
 *
 * Turn kinds, weighted by `mix`:
 *   - `sub`   a streaming turn on the developer's own subscription (passthrough)
 *   - `route` a streaming turn on a routed model, server-held key (substitute)
 *   - `count` `count_tokens`, which Claude Code sends around turns
 *
 * Dashboard pollers and `/api/live` subscribers run alongside, signed in with a
 * real session cookie, because a slow dashboard query on a worker is a stall
 * for every stream on that worker — the one interaction the bench most needs
 * to see.
 *
 * Everything is reported once a second as mergeable histograms (`hist.ts`).
 */

import http from "node:http";
import { performance } from "node:perf_hooks";
import { emptyHist, record, type Hist } from "./hist.ts";
import { nowMs } from "./upstream.ts";

export interface LoadInit {
  readonly t: "init";
  readonly port: number;
  readonly tokens: readonly string[];
  readonly cookie: string;
  readonly mix: { readonly sub: number; readonly route: number; readonly count: number };
  readonly bodyKb: number;
  readonly thinkMs: number;
  readonly pollMs: number;
}

export interface StageMsg {
  readonly t: "stage";
  readonly stage: number;
  readonly developers: number;
  readonly dashboards: number;
  readonly live: number;
}

export interface Tick {
  readonly t: "tick";
  readonly at: number;
  readonly stage: number;
  readonly developers: number;
  readonly inflight: number;
  readonly streams: number;
  readonly turnsOk: number;
  readonly turnsErr: number;
  readonly countOk: number;
  readonly errors: Record<string, number>;
  /** Time to first body byte of a streaming turn. */
  readonly ttfb: Hist;
  /** Per chunk: arrival here minus the upstream's send stamp. */
  readonly relay: Hist;
  readonly countLatency: Hist;
  readonly dashboard: Record<string, Hist>;
  readonly liveRows: number;
  /** Per live row: arrival on `/api/live` minus the turn's end. */
  readonly liveLag: Hist;
  readonly elu: number;
}

export const DASHBOARD_ENDPOINTS: ReadonlyArray<{ name: string; path: (now: number) => string }> = [
  { name: "overview 24h", path: (n) => `/api/overview?from=${n - 86_400_000}&to=${n}` },
  { name: "overview 30d", path: (n) => `/api/overview?from=${n - 30 * 86_400_000}&to=${n}` },
  { name: "requests", path: () => `/api/requests?limit=50` },
  { name: "users 7d", path: (n) => `/api/users?from=${n - 7 * 86_400_000}&to=${n}` },
  { name: "models 30d", path: (n) => `/api/models?from=${n - 30 * 86_400_000}&to=${n}` },
  { name: "tags 30d", path: (n) => `/api/tags?by=team&from=${n - 30 * 86_400_000}&to=${n}` },
  { name: "errors 7d", path: (n) => `/api/errors?from=${n - 7 * 86_400_000}&to=${n}` },
];

const BENCH_TAG = /"bench_t":([0-9.]+)/g;
const CARRY = 48;
const TURN_TIMEOUT_MS = 180_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function bodyFor(model: string, kb: number, stream: boolean): Buffer {
  // A large single user message stands in for Claude Code's context. The text
  // varies so nothing between here and the upstream can dedupe it.
  const text = Array.from({ length: Math.max(1, Math.round(kb)) }, (_, i) =>
    `chunk ${i} `.padEnd(1024, "the quick brown fox jumps over the lazy dog "),
  ).join("");
  return Buffer.from(
    JSON.stringify({
      model,
      max_tokens: 4096,
      ...(stream ? { stream: true } : {}),
      messages: [{ role: "user", content: text }],
    }),
  );
}

if (process.send !== undefined && import.meta.filename === process.argv[1]) {
  let init: LoadInit | null = null;
  let stage = -1;
  let target = { developers: 0, dashboards: 0, live: 0 };
  let draining = false;

  const devs: Array<{ id: number; active: boolean; done: Promise<void> }> = [];
  const pollers: Array<{ active: boolean; done: Promise<void> }> = [];
  const lives: Array<{ stop: () => void }> = [];
  let inflight = 0;
  let streams = 0;

  let acc = fresh();
  function fresh() {
    return {
      turnsOk: 0,
      turnsErr: 0,
      countOk: 0,
      errors: {} as Record<string, number>,
      ttfb: emptyHist(),
      relay: emptyHist(),
      countLatency: emptyHist(),
      dashboard: {} as Record<string, Hist>,
      liveRows: 0,
      liveLag: emptyHist(),
    };
  }
  const fail = (kind: string): void => {
    acc.turnsErr += 1;
    acc.errors[kind] = (acc.errors[kind] ?? 0) + 1;
  };

  let bodies: Record<"sub" | "route" | "count", Buffer> | null = null;

  /** One request on the developer's own connection; resolves when it is over. */
  function turn(agent: http.Agent, token: string, kind: "sub" | "route" | "count"): Promise<void> {
    const cfg = init!;
    const body = bodies![kind];
    const path = kind === "count" ? `/t/${token}/v1/messages/count_tokens?beta=true` : `/t/${token}/v1/messages?beta=true`;
    const headers: http.OutgoingHttpHeaders = {
      "content-type": "application/json",
      "content-length": body.length,
      "anthropic-version": "2023-06-01",
      "user-agent": "claude-cli/2.1.278 (external, cli) fest-bench",
      "x-fest-client": "fest-bench",
    };
    // A subscription bearer makes it passthrough; none makes it the key posture,
    // where the routed model goes to the substitute path.
    if (kind !== "route") headers["authorization"] = "Bearer sk-ant-oat01-fest-bench-not-a-real-token";

    return new Promise<void>((resolve) => {
      const started = nowMs();
      let settled = false;
      const done = (err: string | null): void => {
        if (settled) return;
        settled = true;
        if (err !== null) fail(err);
        resolve();
      };
      const req = http.request({ host: "127.0.0.1", port: cfg.port, method: "POST", path, agent, headers }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          res.on("end", () => done(`http ${res.statusCode}`));
          res.on("error", () => done(`http ${res.statusCode}`));
          return;
        }
        if (kind === "count") {
          res.resume();
          res.on("end", () => {
            record(acc.countLatency, nowMs() - started);
            acc.countOk += 1;
            done(null);
          });
          res.on("error", () => done("count reset"));
          return;
        }
        streams += 1;
        let first = true;
        let carry = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          const at = nowMs();
          if (first) {
            first = false;
            record(acc.ttfb, at - started);
          }
          const text = carry + chunk;
          BENCH_TAG.lastIndex = 0;
          for (let m = BENCH_TAG.exec(text); m !== null; m = BENCH_TAG.exec(text)) {
            // A stamp wholly inside the carried tail was counted last time.
            if (m.index + m[0].length <= carry.length) continue;
            record(acc.relay, at - Number(m[1]));
          }
          carry = text.slice(-CARRY);
        });
        res.on("end", () => {
          streams -= 1;
          acc.turnsOk += 1;
          done(null);
        });
        res.on("error", () => {
          streams -= 1;
          done("stream reset");
        });
      });
      req.setTimeout(TURN_TIMEOUT_MS, () => {
        req.destroy();
        done("timeout");
      });
      req.on("error", (err: NodeJS.ErrnoException) => done(err.code ?? "request error"));
      req.end(body);
    });
  }

  function pickKind(): "sub" | "route" | "count" {
    const { sub, route, count } = init!.mix;
    const r = Math.random() * (sub + route + count);
    return r < sub ? "sub" : r < sub + route ? "route" : "count";
  }

  function startDev(id: number): void {
    const cfg = init!;
    const token = cfg.tokens[id % cfg.tokens.length]!;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30_000 });
    const dev = { id, active: true, done: Promise.resolve() };
    dev.done = (async () => {
      // Spread the starts, so a stage does not begin with a thundering herd.
      await sleep(Math.random() * cfg.thinkMs);
      while (dev.active && !draining) {
        inflight += 1;
        await turn(agent, token, pickKind());
        inflight -= 1;
        if (!dev.active || draining) break;
        await sleep(cfg.thinkMs * (0.5 + Math.random()));
      }
      agent.destroy();
    })();
    devs.push(dev);
  }

  function startPoller(): void {
    const cfg = init!;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const p = { active: true, done: Promise.resolve() };
    let i = Math.floor(Math.random() * DASHBOARD_ENDPOINTS.length);
    p.done = (async () => {
      await sleep(Math.random() * cfg.pollMs);
      while (p.active && !draining) {
        const ep = DASHBOARD_ENDPOINTS[i++ % DASHBOARD_ENDPOINTS.length]!;
        const started = nowMs();
        const ok = await new Promise<boolean>((resolve) => {
          const req = http.get(
            { host: "127.0.0.1", port: cfg.port, path: ep.path(Date.now()), agent, headers: { cookie: cfg.cookie } },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode === 200));
              res.on("error", () => resolve(false));
            },
          );
          req.on("error", () => resolve(false));
        });
        if (ok) record((acc.dashboard[ep.name] ??= emptyHist()), nowMs() - started);
        else acc.errors[`dashboard ${ep.name}`] = (acc.errors[`dashboard ${ep.name}`] ?? 0) + 1;
        await sleep(cfg.pollMs * (0.5 + Math.random()));
      }
      agent.destroy();
    })();
    pollers.push(p);
  }

  function startLive(): void {
    const cfg = init!;
    const req = http.get({ host: "127.0.0.1", port: cfg.port, path: "/api/live", agent: false, headers: { cookie: cfg.cookie } }, (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        const at = Date.now();
        buffer += c;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!frame.includes("event: usage")) continue;
          const data = frame.split("\n").find((l) => l.startsWith("data: "));
          if (data === undefined) continue;
          try {
            const rows = (JSON.parse(data.slice(6)) as { rows: Array<{ startedAt: number; durationMs: number | null }> }).rows;
            for (const r of rows) {
              acc.liveRows += 1;
              record(acc.liveLag, at - (r.startedAt + (r.durationMs ?? 0)));
            }
          } catch {
            acc.errors["live parse"] = (acc.errors["live parse"] ?? 0) + 1;
          }
        }
      });
      res.on("error", () => {});
    });
    req.on("error", () => {});
    lives.push({ stop: () => req.destroy() });
  }

  function apply(): void {
    while (devs.filter((d) => d.active).length < target.developers) startDev(devs.length);
    for (const d of devs.filter((d) => d.active).slice(target.developers)) d.active = false;
    while (pollers.filter((p) => p.active).length < target.dashboards) startPoller();
    for (const p of pollers.filter((p) => p.active).slice(target.dashboards)) p.active = false;
    while (lives.length < target.live) startLive();
    while (lives.length > target.live) lives.pop()!.stop();
  }

  let lastElu = performance.eventLoopUtilization();
  const reporter = setInterval(() => {
    const elu = performance.eventLoopUtilization(lastElu);
    lastElu = performance.eventLoopUtilization();
    const out: Tick = {
      t: "tick",
      at: Date.now(),
      stage,
      developers: devs.filter((d) => d.active).length,
      inflight,
      streams,
      ...acc,
      elu: elu.utilization,
    };
    acc = fresh();
    process.send?.(out);
  }, 1000);

  process.on("message", (m: LoadInit | StageMsg | { t: "drain" } | { t: "stop" }) => {
    if (m.t === "init") {
      init = m;
      bodies = {
        sub: bodyFor("claude-sonnet-5", m.bodyKb, true),
        route: bodyFor("bench-oss-1", m.bodyKb, true),
        count: bodyFor("claude-sonnet-5", m.bodyKb, false),
      };
      process.send?.({ t: "ready" });
    } else if (m.t === "stage") {
      stage = m.stage;
      target = { developers: m.developers, dashboards: m.dashboards, live: m.live };
      apply();
    } else if (m.t === "drain") {
      draining = true;
      for (const d of devs) d.active = false;
      for (const p of pollers) p.active = false;
      void Promise.all([...devs, ...pollers].map((x) => x.done)).then(() => {
        // One last tick so the final turns are counted, then the all-clear.
        setTimeout(() => {
          for (const l of lives) l.stop();
          process.send?.({ t: "drained" });
        }, 1100);
      });
    } else if (m.t === "stop") {
      clearInterval(reporter);
      process.exit(0);
    }
  });
  process.on("disconnect", () => process.exit(0));
}
