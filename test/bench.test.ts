/**
 * The bench's own arithmetic. A performance harness that reports a wrong
 * percentile, double-counts a recursive function or quietly loads a remote
 * asset is worse than none: its numbers get believed.
 *
 * The end-to-end path (real gateway, generators, report) is exercised by
 * `npm run bench -- --quick` in CI rather than here — it takes a minute and its
 * numbers are machine-dependent, which suits neither `npm test` nor assertions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { emptyHist, merge, quantile, record, summarize } from "../tools/bench/hist.ts";
import { summarizeProfile, type CpuProfile } from "../tools/bench/profile.ts";
import { renderReport } from "../tools/bench/report.ts";
import { startUpstream } from "../tools/bench/upstream.ts";
import type { BenchResult, RunResult } from "../tools/bench/run.ts";

test("histogram percentiles are within the bucket error, and merge like one histogram", () => {
  const a = emptyHist();
  const b = emptyHist();
  for (let v = 1; v <= 1000; v += 1) record(v % 2 === 0 ? a : b, v);
  const all = merge(merge(emptyHist(), a), b);
  assert.equal(all.n, 1000);
  for (const [q, want] of [[0.5, 500], [0.9, 900], [0.99, 990]] as const) {
    const got = quantile(all, q)!;
    assert.ok(Math.abs(got - want) / want <= 0.026, `p${q * 100}: ${got} vs ${want}`);
  }
  assert.equal(quantile(all, 1), 1000);
  assert.equal(all.max, 1000);
  assert.equal(quantile(emptyHist(), 0.5), null, "no data is null, never zero");
  assert.deepEqual(summarize(emptyHist()).p99, null);
  // Sub-floor and negative values are clamped, not lost.
  const tiny = emptyHist();
  record(tiny, -3);
  record(tiny, 0.001);
  record(tiny, Number.NaN);
  assert.equal(tiny.n, 2);
});

test("profile summary: self from the sample stream, inclusive once per sample, areas by subsystem", () => {
  const root = "/repo";
  const frame = (functionName: string, url: string) => ({ functionName, url, lineNumber: 9, columnNumber: 0 });
  // root → handle (server/http) → write (server/store) → write (recursion) ; plus idle and GC
  const profile: CpuProfile = {
    startTime: 0,
    endTime: 10_000,
    nodes: [
      { id: 1, callFrame: frame("(root)", ""), children: [2, 5, 6] },
      { id: 2, callFrame: frame("handle", "file:///repo/server/http/server.ts"), children: [3] },
      { id: 3, callFrame: frame("write", "file:///repo/server/store/write.ts"), children: [4] },
      { id: 4, callFrame: frame("write", "file:///repo/server/store/write.ts"), children: [7] },
      { id: 5, callFrame: frame("(idle)", "") },
      { id: 6, callFrame: frame("(garbage collector)", "") },
      { id: 7, callFrame: frame("parse", "node:internal/streams/readable") },
    ],
    samples: [4, 4, 3, 2, 5, 5, 6, 7],
    timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
  };
  const s = summarizeProfile(profile, root);
  assert.equal(s.wallMs, 8);
  assert.equal(s.busyMs, 6, "idle is excluded from busy");
  const write = s.festInclusive.find((f) => f.fn === "write")!;
  // Samples in nodes 4, 4, 3 and 7 are all under `write`: 4ms, not 6ms for the recursion.
  assert.equal(write.totalMs, 4);
  assert.equal(write.selfMs, 3);
  assert.equal(write.loc, "server/store/write.ts:10");
  assert.equal(s.festInclusive[0]!.fn, "handle", "the entry point carries everything under it");
  assert.equal(s.festInclusive[0]!.totalMs, 5);
  const area = Object.fromEntries(s.areas.map((a) => [a.area, a.ms]));
  assert.deepEqual(area, { "fest: server/store": 3, "fest: server/http": 1, gc: 1, "node: streams": 1 });
  assert.ok(!s.topSelf.some((f) => f.fn.startsWith("(")), "pseudo-frames are areas, not functions");
});

test("the fake upstream stamps every chunk and ends with usage", async (t) => {
  const up = await startUpstream({ ttfbMs: 5, chunks: 3, chunkIntervalMs: 2, chunkChars: 10 });
  t.after(() => new Promise<void>((r) => up.server.close(() => r())));
  const body = await new Promise<string>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: up.port, method: "POST", path: "/t/x/v1/messages?beta=true" }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (s += c));
      res.on("end", () => resolve(s));
    });
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(body.match(/"bench_t":\d+\.\d+/g)?.length, 3);
  assert.match(body, /event: message_start/);
  assert.match(body, /"usage":\{"output_tokens":24\}/);
  assert.match(body, /event: message_stop/);
});

test("the report is one self-contained file", () => {
  const stage = {
    stage: 0, developers: 10, seconds: 5, turnsPerSec: 3, countPerSec: 0.5, streamsAvg: 8, chunksPerSec: 100,
    ttfb: summarize(emptyHist()), ttfbOverheadP50: 2, ttfbOverheadP99: 4,
    relay: { n: 10, p50: 0.3, p90: 0.5, p99: 1.2, max: 2, mean: 0.4 },
    countLatency: summarize(emptyHist()), errorRate: 0, errors: {},
    dashboard: { "overview 30d": { n: 3, p50: 5, p90: 8, p99: 9, max: 9, mean: 6 } },
    liveLag: summarize(emptyHist()), liveRows: 0,
    procs: { "worker-1": { elu: 0.2, eldP99: 1, cpu: 0.2, rssMb: 140 }, primary: { elu: 0.05, eldP99: 0.5, cpu: 0.05, rssMb: 110 } },
    genEluMax: 0.1, upstreamElu: 0.1, held: true, failed: [],
  };
  const run: RunResult = {
    label: "2 workers <&>", workers: 2, stages: [stage, { ...stage, developers: 20, held: false, failed: ["chunk relay p99 99ms > 50ms"] }],
    timeline: [{ sec: 1, stage: 0, developers: 10, streams: 8, turnsPerSec: 3, errors: 0, relayP50: 0.3, relayP99: 1.2, ttfbP99: 304, dashboardP99: 9, sinkQueued: 0, genElu: 0.1, upstreamElu: 0.1 }],
    procTimeline: [{ sec: 1, role: "worker-1", elu: 0.2, eldP99: 1, eldMax: 2, cpu: 0.2, rss: 140 * 1048576, gcMs: 1 }],
    profiles: [], profiledAt: null, persisted: { ok: 30, rows: 31, turnsOk: 30, match: true }, maxHeld: 10, gatewayExit: 0, warnings: ["<b>not html</b>"],
  };
  const result = {
    meta: { startedAt: "2026-10-14T00:00:00.000Z", durationS: 60, git: "abc1234", dirty: false, festVersion: "0.7.1", node: "v26.11.1", sqlite: "3.53.4", os: "Darwin", cpu: "test cpu", cores: 8, memGb: 16, historyRows: 100 },
    params: {
      name: "unit", workers: [2], baseline: false, stages: [10, 20], stageSeconds: 5, warmupSeconds: 1, historyRows: 100, historyDays: 1,
      bodyKb: 1, thinkMs: 100, mix: { sub: 1, route: 0, count: 0 }, dashboards: 1, live: 0, pollMs: 100, genProcs: 1,
      shape: { ttfbMs: 300, chunks: 5, chunkIntervalMs: 10, chunkChars: 10 }, profile: false,
      slo: { relayP99Ms: 50, ttfbOverheadP99Ms: 100, errorRate: 0.005 },
    },
    runs: [run],
  } satisfies BenchResult;
  const html = renderReport(result);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<svg /);
  assert.doesNotMatch(html, /<script|<link|<img|src=|url\(|@import|https?:\/\//i, "nothing to fetch, nothing to run");
  assert.ok(html.includes("2 workers &lt;&amp;&gt;"), "labels are escaped");
  assert.ok(html.includes("&lt;b&gt;not html&lt;/b&gt;"), "warnings are escaped");
  assert.ok(html.includes("within SLO up to <b>10 simulated developers</b>"));
  const none = renderReport({ ...result, runs: [{ ...run, maxHeld: null, stages: [{ ...stage, held: false, failed: ["chunk relay p99 99ms > 50ms"] }] }] });
  assert.ok(none.includes("No configuration met the SLO at any stage"), "a run that held nothing says so, and why");
  assert.ok(none.includes("chunk relay p99 99ms &gt; 50ms at 10 developers"));
});
