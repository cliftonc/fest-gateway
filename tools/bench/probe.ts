/**
 * Preloaded into every gateway process by the bench (`NODE_OPTIONS=--import`),
 * so the server needs no bench code and no flag of its own. The cluster primary
 * and every forked worker inherit `NODE_OPTIONS`, so each process samples
 * itself.
 *
 * Every SAMPLE_MS it appends one JSON line to `$FEST_BENCH_PROBE_DIR/<pid>.jsonl`:
 * event-loop utilisation, event-loop delay (p50/p99/max over the interval), GC
 * time, CPU, RSS and heap. Event-loop delay is the number that matters for a
 * relay: it is how late every stream on that process is being served.
 *
 * The write is synchronous, to one fd opened once, and a few hundred bytes four
 * times a second — negligible next to what it measures, and it survives a
 * SIGKILL up to the last sample.
 *
 * `monitorEventLoopDelay` reports each timer's whole interval, so an idle loop
 * reads as its own resolution; that is subtracted, leaving the lateness.
 */

import cluster from "node:cluster";
import { mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";

const dir = process.env.FEST_BENCH_PROBE_DIR;
const SAMPLE_MS = 250;
const RESOLUTION_MS = 5;

if (dir !== undefined && dir !== "") {
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${process.pid}.jsonl`), "a");
  const role = cluster.isWorker ? `worker-${cluster.worker?.id ?? "?"}` : "main";

  const eld = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  eld.enable();
  let gcMs = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) gcMs += e.duration;
  }).observe({ entryTypes: ["gc"] });

  const late = (ns: number): number => Math.max(0, ns / 1e6 - RESOLUTION_MS);
  let lastElu = performance.eventLoopUtilization();
  let lastCpu = process.cpuUsage();
  let lastAt = performance.now();

  const sample = (): void => {
    const now = performance.now();
    const elu = performance.eventLoopUtilization(lastElu);
    lastElu = performance.eventLoopUtilization();
    const cpu = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    const wallMs = now - lastAt;
    lastAt = now;
    const mem = process.memoryUsage();
    const line = {
      t: performance.timeOrigin + now,
      pid: process.pid,
      role,
      elu: elu.utilization,
      // Nanoseconds from the histogram; the bench works in milliseconds.
      eldP50: eld.count > 0 ? late(eld.percentile(50)) : null,
      eldP99: eld.count > 0 ? late(eld.percentile(99)) : null,
      eldMax: eld.count > 0 ? late(eld.max) : null,
      gcMs,
      cpu: wallMs > 0 ? (cpu.user + cpu.system) / 1000 / wallMs : 0,
      rss: mem.rss,
      heap: mem.heapUsed,
    };
    eld.reset();
    gcMs = 0;
    try {
      writeSync(fd, JSON.stringify(line) + "\n");
    } catch {
      // A probe must never take the process it measures down with it.
    }
  };
  setInterval(sample, SAMPLE_MS).unref();
}
