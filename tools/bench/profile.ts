/**
 * Reduce a V8 `.cpuprofile` (what `node --cpu-prof` writes) to the numbers a
 * person can act on: where the CPU went, by area and by function.
 *
 * Self time is attributed from the sample stream (`samples` + `timeDeltas`),
 * not `hitCount × interval`, so a profile with an uneven sampling rate still
 * adds up. Inclusive time walks each sample's stack once and counts a function
 * once per sample, so recursion does not inflate it.
 *
 * Areas, coarsest first: idle, GC, native/program, Node internals by module
 * (`node:internal/http…` → `http`), dependencies by package, and Fest itself
 * by subsystem (`server/store`, `server/pipeline`, …) — the last is what tells
 * you which part of Fest to look at. The bench's own probe, which runs inside
 * every gateway process, is its own area so it is never mistaken for Fest.
 */

import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface CallFrame {
  readonly functionName: string;
  readonly url: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
}

interface ProfileNode {
  readonly id: number;
  readonly callFrame: CallFrame;
  readonly children?: readonly number[];
}

export interface CpuProfile {
  readonly nodes: readonly ProfileNode[];
  readonly startTime: number;
  readonly endTime: number;
  readonly samples?: readonly number[];
  readonly timeDeltas?: readonly number[];
}

export interface FunctionCost {
  readonly fn: string;
  /** Repo-relative path:line, `node:…`, or a package name. */
  readonly loc: string;
  readonly area: string;
  readonly selfMs: number;
  readonly totalMs: number;
}

export interface ProfileSummary {
  readonly wallMs: number;
  /** Everything but idle: what the process actually spent on CPU. */
  readonly busyMs: number;
  readonly areas: ReadonlyArray<{ area: string; ms: number }>;
  readonly topSelf: readonly FunctionCost[];
  /** Fest's own functions by inclusive time — the entry points worth reading. */
  readonly festInclusive: readonly FunctionCost[];
}

function locate(frame: CallFrame, root: string): { loc: string; area: string } {
  const { url, functionName } = frame;
  if (url === "") {
    if (functionName === "(idle)") return { loc: "", area: "idle" };
    if (functionName === "(garbage collector)") return { loc: "", area: "gc" };
    return { loc: "", area: "native / program" };
  }
  // Node's own WebAssembly (the HTTP parser, the type stripper), never Fest's.
  if (url.startsWith("wasm:")) return { loc: "wasm", area: "node: wasm" };
  if (url.startsWith("node:")) {
    const mod = url.replace(/^node:(internal\/)?/, "").split("/")[0] ?? url;
    return { loc: `${url}:${frame.lineNumber + 1}`, area: `node: ${mod.replace(/_.*$/, "")}` };
  }
  let path = url;
  if (url.startsWith("file://")) {
    try {
      path = fileURLToPath(url);
    } catch {
      path = url;
    }
  }
  const nm = path.lastIndexOf(`node_modules${sep}`);
  if (nm !== -1) {
    const rest = path.slice(nm + "node_modules/".length).split(sep);
    const pkg = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : (rest[0] ?? "?");
    return { loc: pkg, area: `dep: ${pkg}` };
  }
  const rel = relative(root, path);
  if (rel.startsWith("..")) return { loc: `${path}:${frame.lineNumber + 1}`, area: "other" };
  const parts = rel.split(sep);
  // The bench's probe runs inside the gateway; its cost is the bench's, not Fest's.
  if (parts[0] === "tools") return { loc: `${rel}:${frame.lineNumber + 1}`, area: "bench probe" };
  const area = parts[0] === "server" || parts[0] === "shared" || parts[0] === "cli"
    ? parts.length > 2 ? `fest: ${parts[0]}/${parts[1]}` : `fest: ${parts[0]}`
    : `fest: ${parts[0]}`;
  return { loc: `${rel}:${frame.lineNumber + 1}`, area };
}

export function summarizeProfile(profile: CpuProfile, root: string, top = 25): ProfileSummary {
  const byId = new Map<number, ProfileNode>();
  const parent = new Map<number, number>();
  for (const n of profile.nodes) {
    byId.set(n.id, n);
    for (const c of n.children ?? []) parent.set(c, n.id);
  }

  const located = new Map<number, { key: string; fn: string; loc: string; area: string }>();
  for (const n of profile.nodes) {
    const { loc, area } = locate(n.callFrame, root);
    const fn = n.callFrame.functionName === "" ? "(anonymous)" : n.callFrame.functionName;
    located.set(n.id, { key: `${fn}@${loc}`, fn, loc, area });
  }

  const self = new Map<string, number>();
  const total = new Map<string, number>();
  const areas = new Map<string, number>();
  const meta = new Map<string, { fn: string; loc: string; area: string }>();

  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  let wallUs = 0;
  for (let i = 0; i < samples.length; i += 1) {
    // timeDeltas[i] is the gap BEFORE sample i; attributing it to sample i is
    // what Chrome DevTools does.
    const us = Math.max(0, deltas[i] ?? 0);
    wallUs += us;
    const id = samples[i]!;
    const leaf = located.get(id);
    if (leaf === undefined) continue;
    meta.set(leaf.key, leaf);
    self.set(leaf.key, (self.get(leaf.key) ?? 0) + us);
    areas.set(leaf.area, (areas.get(leaf.area) ?? 0) + us);
    const seen = new Set<string>();
    for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
      const l = located.get(cur);
      if (l === undefined || seen.has(l.key)) continue;
      seen.add(l.key);
      meta.set(l.key, l);
      total.set(l.key, (total.get(l.key) ?? 0) + us);
    }
  }

  const cost = (key: string): FunctionCost => {
    const m = meta.get(key)!;
    return { ...m, selfMs: (self.get(key) ?? 0) / 1000, totalMs: (total.get(key) ?? 0) / 1000 };
  };
  const notIdle = (k: string): boolean => meta.get(k)?.area !== "idle" && !meta.get(k)?.fn.startsWith("(");

  const idleUs = areas.get("idle") ?? 0;
  return {
    wallMs: wallUs / 1000,
    busyMs: (wallUs - idleUs) / 1000,
    areas: [...areas.entries()]
      .filter(([a]) => a !== "idle")
      .map(([area, us]) => ({ area, ms: us / 1000 }))
      .sort((a, b) => b.ms - a.ms),
    // "(program)", "(garbage collector)": areas, not functions anyone can fix.
    topSelf: [...self.keys()]
      .filter(notIdle)
      .map(cost)
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, top),
    festInclusive: [...total.keys()]
      .filter((k) => notIdle(k) && (meta.get(k)?.area.startsWith("fest:") ?? false))
      .map(cost)
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 15),
  };
}

export function summarizeProfileFile(path: string, root: string): ProfileSummary {
  return summarizeProfile(JSON.parse(readFileSync(path, "utf8")) as CpuProfile, root);
}
