/**
 * The bench result as one self-contained HTML file: inline CSS, inline SVG
 * charts, no scripts, no fonts or images to fetch. It renders the same from a
 * repo checkout, an email attachment or a CI artifact, and diffs as text.
 *
 * Pure: `BenchResult` in, a string out. `run.ts --render x.json` re-renders a
 * saved result, so a change here never needs a re-run.
 */

import type { BenchResult, RunResult, StageResult } from "./run.ts";
import type { Summary } from "./hist.ts";

// ── Formatting ────────────────────────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}s`;
  if (v >= 100) return `${v.toFixed(0)}ms`;
  if (v >= 10) return `${v.toFixed(1)}ms`;
  return `${v.toFixed(2)}ms`;
}
const pct = (v: number | null | undefined, d = 0): string => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(d)}%`);
const num = (v: number, d = 0): string => v.toLocaleString("en", { maximumFractionDigits: d, minimumFractionDigits: d });

const PALETTE = ["#9aa0a6", "#2563eb", "#16a34a", "#ea580c", "#9333ea", "#db2777", "#0891b2", "#ca8a04", "#4b5563"];

// ── Charts ────────────────────────────────────────────────────────────────

interface Series {
  readonly name: string;
  readonly color: string;
  readonly points: ReadonlyArray<readonly [number, number | null]>;
  readonly dashed?: boolean;
}

interface ChartOpts {
  readonly title: string;
  readonly yLabel: string;
  readonly xLabel: string;
  readonly series: readonly Series[];
  readonly logX?: boolean;
  readonly logY?: boolean;
  readonly yFmt?: (v: number) => string;
  readonly xFmt?: (v: number) => string;
  readonly hLines?: ReadonlyArray<{ y: number; label: string }>;
  readonly bands?: ReadonlyArray<{ from: number; to: number; label: string }>;
  readonly width?: number;
  readonly height?: number;
  readonly yMin?: number;
}

function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

function logTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  // 1-2-5 per decade reads well over two or three decades; past that, decades only.
  const mantissas = Math.log10(hi / lo) > 3 ? [1] : [1, 2, 5];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e += 1) {
    for (const m of mantissas) {
      const v = m * 10 ** e;
      if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
    }
  }
  return out;
}

function chart(o: ChartOpts): string {
  const W = o.width ?? 560;
  const H = o.height ?? 260;
  const m = { l: 56, r: 14, t: 30, b: 40 };
  const pts = o.series.flatMap((s) => s.points.filter((p): p is readonly [number, number] => p[1] !== null && Number.isFinite(p[1])));
  if (pts.length === 0) return `<figure class="chart"><figcaption>${esc(o.title)}</figcaption><p class="muted">no data</p></figure>`;
  const xs = pts.map((p) => p[0]);
  const ys = [...pts.map((p) => p[1]), ...(o.hLines ?? []).map((h) => h.y)];
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  if (x0 === x1) { x0 -= 1; x1 += 1; }
  let y0 = o.logY ? Math.max(Math.min(...ys.filter((y) => y > 0)), 1e-3) : Math.min(o.yMin ?? 0, ...ys);
  let y1 = Math.max(...ys);
  if (o.logY) { y0 = 10 ** Math.floor(Math.log10(y0)); y1 = 10 ** Math.ceil(Math.log10(y1 * 1.05)); }
  else { const t = niceTicks(y0, y1 * 1.08 || 1); y1 = t.at(-1)! < y1 ? y1 * 1.1 : t.at(-1)!; }
  const fx = o.logX
    ? (x: number) => m.l + ((Math.log(x) - Math.log(x0)) / (Math.log(x1) - Math.log(x0) || 1)) * (W - m.l - m.r)
    : (x: number) => m.l + ((x - x0) / (x1 - x0)) * (W - m.l - m.r);
  const fy = o.logY
    ? (y: number) => H - m.b - ((Math.log(Math.max(y, y0)) - Math.log(y0)) / (Math.log(y1) - Math.log(y0) || 1)) * (H - m.t - m.b)
    : (y: number) => H - m.b - ((y - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
  const yFmt = o.yFmt ?? ((v: number) => num(v, v < 10 && v % 1 !== 0 ? 1 : 0));
  const xFmt = o.xFmt ?? ((v: number) => num(v));
  const yt = o.logY ? logTicks(y0, y1) : niceTicks(y0, y1);
  const xt = o.logX ? logTicks(x0, x1) : niceTicks(x0, x1, 6);

  const parts: string[] = [];
  for (const b of o.bands ?? []) {
    const a = fx(Math.max(b.from, x0)), z = fx(Math.min(b.to, x1));
    parts.push(`<rect x="${a.toFixed(1)}" y="${m.t}" width="${Math.max(0, z - a).toFixed(1)}" height="${H - m.t - m.b}" class="band"/>`);
    parts.push(`<text x="${((a + z) / 2).toFixed(1)}" y="${m.t + 10}" class="bandlabel">${esc(b.label)}</text>`);
  }
  for (const v of yt) {
    const y = fy(v).toFixed(1);
    parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}" class="grid"/><text x="${m.l - 6}" y="${y}" class="ytick">${esc(yFmt(v))}</text>`);
  }
  for (const v of xt) {
    const x = fx(v).toFixed(1);
    parts.push(`<line x1="${x}" x2="${x}" y1="${H - m.b}" y2="${H - m.b + 4}" class="axis"/><text x="${x}" y="${H - m.b + 16}" class="xtick">${esc(xFmt(v))}</text>`);
  }
  for (const h of o.hLines ?? []) {
    const y = fy(h.y).toFixed(1);
    parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}" class="slo"/><text x="${W - m.r - 4}" y="${Number(y) - 4}" class="slolabel">${esc(h.label)}</text>`);
  }
  for (const s of o.series) {
    const segs: string[][] = [[]];
    for (const [x, y] of s.points) {
      if (y === null || !Number.isFinite(y)) { segs.push([]); continue; }
      segs.at(-1)!.push(`${fx(x).toFixed(1)},${fy(y).toFixed(1)}`);
    }
    for (const seg of segs.filter((g) => g.length > 0)) {
      parts.push(`<polyline points="${seg.join(" ")}" fill="none" stroke="${s.color}" stroke-width="2"${s.dashed ? ' stroke-dasharray="5 4"' : ""}/>`);
      if (s.points.length <= 12) for (const p of seg) { const [cx, cy] = p.split(","); parts.push(`<circle cx="${cx}" cy="${cy}" r="3" fill="${s.color}"/>`); }
    }
  }
  parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" class="axis"/>`);
  parts.push(`<text x="${(m.l + W - m.r) / 2}" y="${H - 6}" class="xlabel">${esc(o.xLabel)}</text>`);
  parts.push(`<text x="12" y="${(m.t + H - m.b) / 2}" class="ylabel" transform="rotate(-90 12 ${(m.t + H - m.b) / 2})">${esc(o.yLabel)}</text>`);
  const legend = o.series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("");
  return `<figure class="chart"><figcaption>${esc(o.title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title)}">${parts.join("")}</svg><div class="legend">${legend}</div></figure>`;
}

function hbar(rows: ReadonlyArray<{ label: string; value: number }>, fmt: (v: number) => string): string {
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  return `<div class="hbar">${rows
    .map((r) => `<div class="hrow"><span class="hl" title="${esc(r.label)}">${esc(r.label)}</span><span class="hb"><i style="width:${((r.value / max) * 100).toFixed(1)}%"></i></span><span class="hv">${esc(fmt(r.value))}</span></div>`)
    .join("")}</div>`;
}

// ── Sections ──────────────────────────────────────────────────────────────

const colorOf = (runs: readonly RunResult[], r: RunResult): string => PALETTE[r.workers === 0 ? 0 : 1 + (runs.filter((x) => x.workers > 0).indexOf(r) % (PALETTE.length - 1))]!;

function headline(res: BenchResult): string {
  const cards = res.runs.map((r) => {
    const held = r.stages.filter((s) => s.held);
    const last = held.at(-1) ?? null;
    const peak = Math.max(0, ...r.stages.map((s) => s.turnsPerSec));
    const ok = r.persisted === null ? null : r.persisted.match;
    // With nothing held, the lightest stage and why it failed say the most.
    const at = last ?? r.stages[0] ?? null;
    return `<div class="card" style="border-top-color:${colorOf(res.runs, r)}">
      <div class="cardtitle">${esc(r.label)}</div>
      <div class="big">${r.maxHeld === null ? "none" : num(r.maxHeld)}<small> developers within SLO</small></div>
      ${r.maxHeld === null && at !== null ? `<div class="why">failed from ${num(at.developers)}: ${esc(at.failed[0] ?? "")}</div>` : ""}
      <dl>
        <dt>peak turns/s</dt><dd>${num(peak, 1)}</dd>
        <dt>relay p50 / p99 at ${at === null ? "—" : num(at.developers)}</dt><dd>${ms(at?.relay.p50)} / ${ms(at?.relay.p99)}</dd>
        <dt>TTFB overhead p99</dt><dd>${ms(at?.ttfbOverheadP99)}</dd>
        <dt>every turn persisted</dt><dd>${ok === null ? "n/a" : ok ? '<span class="good">yes</span>' : `<span class="bad">no (${r.persisted!.ok}/${r.persisted!.turnsOk})</span>`}</dd>
      </dl>
    </div>`;
  });
  return `<div class="cards">${cards.join("")}</div>`;
}

function scaling(res: BenchResult): string {
  const runs = res.runs;
  const line = (pick: (s: StageResult) => number | null) =>
    runs.map((r) => ({ name: r.label, color: colorOf(runs, r), dashed: r.workers === 0, points: r.stages.map((s) => [s.developers, pick(s)] as const) }));
  const fest = runs.filter((r) => r.workers > 0);
  const lineFest = (pick: (s: StageResult) => number | null) =>
    fest.map((r) => ({ name: r.label, color: colorOf(runs, r), points: r.stages.map((s) => [s.developers, pick(s)] as const) }));
  const x = { xLabel: "simulated developers", logX: true };
  return `<div class="grid2">
    ${chart({ title: "Chunk relay latency, p99", yLabel: "ms", ...x, logY: true, yFmt: ms, series: line((s) => s.relay.p99), hLines: [{ y: res.params.slo.relayP99Ms, label: `SLO ${res.params.slo.relayP99Ms}ms` }] })}
    ${chart({ title: "Completed streaming turns per second", yLabel: "turns/s", ...x, series: line((s) => s.turnsPerSec) })}
    ${chart({ title: "Time-to-first-byte added by Fest, p99", yLabel: "ms", ...x, yFmt: ms, series: lineFest((s) => s.ttfbOverheadP99), hLines: [{ y: res.params.slo.ttfbOverheadP99Ms, label: `SLO ${res.params.slo.ttfbOverheadP99Ms}ms` }] })}
    ${chart({ title: "Dashboard API latency, p99 (all endpoints)", yLabel: "ms", ...x, logY: true, yFmt: ms, series: lineFest((s) => worstP99(s.dashboard)) })}
    ${chart({ title: "Busiest HTTP process: event-loop utilisation", yLabel: "ELU", ...x, yFmt: (v) => pct(v), series: lineFest((s) => maxOf(s, (p) => p.elu)), hLines: [{ y: 1, label: "saturated" }] })}
    ${chart({ title: "Worst event-loop delay p99 (any HTTP process)", yLabel: "ms", ...x, logY: true, yFmt: ms, series: lineFest((s) => maxOf(s, (p) => p.eldP99)) })}
  </div>`;
}

const httpProcs = (s: StageResult) => Object.entries(s.procs).filter(([role]) => role !== "primary");
function maxOf(s: StageResult, pick: (p: StageResult["procs"][string]) => number | null): number | null {
  const v = httpProcs(s).map(([, p]) => pick(p)).filter((x): x is number => x !== null);
  return v.length === 0 ? null : Math.max(...v);
}
function worstP99(d: Record<string, Summary>): number | null {
  const v = Object.values(d).map((x) => x.p99).filter((x): x is number => x !== null);
  return v.length === 0 ? null : Math.max(...v);
}

function stageTable(r: RunResult, res: BenchResult): string {
  const rows = r.stages.map((s) => {
    const elu = maxOf(s, (p) => p.elu);
    const eld = maxOf(s, (p) => p.eldP99);
    const primary = s.procs["primary"];
    const errs = Object.entries(s.errors).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(", ");
    return `<tr class="${s.held ? "" : "fail"}">
      <td>${num(s.developers)}</td><td>${num(s.streamsAvg)}</td><td>${num(s.turnsPerSec, 1)}</td><td>${num(s.chunksPerSec)}</td>
      <td>${ms(s.relay.p50)}</td><td>${ms(s.relay.p99)}</td><td>${ms(s.relay.max)}</td>
      <td>${ms(s.ttfbOverheadP50)}</td><td>${ms(s.ttfbOverheadP99)}</td>
      <td>${ms(worstP99(s.dashboard))}</td><td>${ms(s.liveLag.p99)}</td>
      <td>${pct(elu)}</td><td>${ms(eld)}</td><td>${primary ? pct(primary.elu) : "—"}</td>
      <td title="${esc(errs)}">${pct(s.errorRate, 2)}</td>
      <td>${s.held ? '<span class="good">✓</span>' : `<span class="bad" title="${esc(s.failed.join("; "))}">✗</span>`}</td>
    </tr>`;
  });
  return `<table class="data"><thead><tr>
    <th>devs</th><th>open streams</th><th>turns/s</th><th>chunks/s</th>
    <th>relay p50</th><th>relay p99</th><th>relay max</th>
    <th>TTFB +p50</th><th>TTFB +p99</th>
    <th>dash p99</th><th>live lag p99</th>
    <th>max ELU</th><th>max ELD p99</th><th>primary ELU</th>
    <th>errors</th><th>SLO</th></tr></thead><tbody>${rows.join("")}</tbody></table>
    ${r.stages.some((s) => !s.held) ? `<p class="muted">Failed stages: ${r.stages.filter((s) => !s.held).map((s) => `<b>${s.developers}</b> — ${esc(s.failed.join("; "))}`).join(" · ")}</p>` : ""}
    ${res.params.dashboards > 0 && r.workers > 0 ? dashboardTable(r) : ""}`;
}

function dashboardTable(r: RunResult): string {
  const names = [...new Set(r.stages.flatMap((s) => Object.keys(s.dashboard)))];
  if (names.length === 0) return "";
  return `<details><summary>Dashboard endpoints, p50 / p99 by stage</summary><table class="data"><thead><tr><th>endpoint</th>${r.stages.map((s) => `<th>${num(s.developers)}</th>`).join("")}</tr></thead><tbody>${names
    .map((n) => `<tr><td>${esc(n)}</td>${r.stages.map((s) => `<td>${ms(s.dashboard[n]?.p50)} / ${ms(s.dashboard[n]?.p99)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></details>`;
}

function timelines(r: RunResult, res: BenchResult): string {
  const t = r.timeline;
  const stageBands: Array<{ from: number; to: number; label: string }> = [];
  for (const p of t) {
    const last = stageBands.at(-1);
    if (last && last.label === String(res.params.stages[p.stage] ?? "")) last.to = p.sec;
    else stageBands.push({ from: p.sec, to: p.sec, label: String(res.params.stages[p.stage] ?? "") });
  }
  const bands = stageBands.filter((_, i) => i % 2 === 1);
  const x = { xLabel: "seconds", bands };
  const roles = [...new Set(r.procTimeline.map((s) => s.role))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const perRole = (pick: (s: RunResult["procTimeline"][number]) => number | null) =>
    roles.map((role, i) => {
      const bySec = new Map<number, number[]>();
      for (const s of r.procTimeline.filter((s) => s.role === role)) {
        const v = pick(s);
        if (v === null) continue;
        const k = Math.round(s.sec);
        bySec.set(k, [...(bySec.get(k) ?? []), v]);
      }
      return {
        name: role,
        color: role === "primary" ? "#111827" : PALETTE[1 + (i % (PALETTE.length - 1))]!,
        dashed: role === "primary",
        points: [...bySec.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, Math.max(...v)] as const),
      };
    });
  const charts = [
    chart({ title: "Load: developers and open streams", yLabel: "count", ...x, series: [
      { name: "developers", color: "#9aa0a6", points: t.map((p) => [p.sec, p.developers] as const) },
      { name: "open streams", color: "#2563eb", points: t.map((p) => [p.sec, p.streams] as const) },
    ] }),
    chart({ title: "Chunk relay latency", yLabel: "ms", ...x, logY: true, yFmt: ms, series: [
      { name: "p50", color: "#16a34a", points: t.map((p) => [p.sec, p.relayP50] as const) },
      { name: "p99", color: "#ea580c", points: t.map((p) => [p.sec, p.relayP99] as const) },
      ...(r.workers > 0 ? [{ name: "dashboard p99", color: "#9333ea", dashed: true, points: t.map((p) => [p.sec, p.dashboardP99] as const) }] : []),
    ], hLines: [{ y: res.params.slo.relayP99Ms, label: "SLO" }] }),
  ];
  if (r.workers > 0) {
    charts.push(
      chart({ title: "Event-loop utilisation per process", yLabel: "ELU", ...x, yFmt: (v) => pct(v), series: perRole((s) => s.elu) }),
      chart({ title: "Event-loop delay p99 per process", yLabel: "ms", ...x, logY: true, yFmt: ms, series: perRole((s) => s.eldP99) }),
      chart({ title: "CPU per process", yLabel: "cores", ...x, series: perRole((s) => s.cpu) }),
      chart({ title: "Resident memory per process", yLabel: "MiB", ...x, series: perRole((s) => s.rss / 1048576) }),
      chart({ title: "Usage sink queue depth (as reported by /healthz)", yLabel: "records", ...x, series: [
        { name: "queued", color: "#0891b2", points: t.map((p) => [p.sec, p.sinkQueued] as const) },
      ] }),
      chart({ title: "Bench health: generator and upstream ELU", yLabel: "ELU", ...x, yFmt: (v) => pct(v), series: [
        { name: "busiest generator", color: "#ca8a04", points: t.map((p) => [p.sec, p.genElu] as const) },
        { name: "fake upstream", color: "#4b5563", points: t.map((p) => [p.sec, p.upstreamElu] as const) },
      ], hLines: [{ y: 0.9, label: "bench-bound past here" }] }),
    );
  }
  return `<div class="grid2">${charts.join("")}</div>`;
}

function profiles(r: RunResult): string {
  if (r.profiles.length === 0) return r.workers === 0 ? "" : `<p class="muted">No CPU profiles (run without --no-profile, and let the gateway exit cleanly).</p>`;
  // Workers are interchangeable; show the busiest one in full and the rest folded.
  const http = r.profiles.filter((p) => p.role !== "primary").sort((a, b) => b.summary.busyMs - a.summary.busyMs);
  const primary = r.profiles.filter((p) => p.role === "primary");
  const block = (p: RunResult["profiles"][number], open: boolean): string => {
    const s = p.summary;
    return `<details${open ? " open" : ""}><summary><b>${esc(p.role)}</b> — busy ${num(s.busyMs / 1000, 1)}s of ${num(s.wallMs / 1000, 1)}s (${pct(s.busyMs / Math.max(1, s.wallMs))})</summary>
      <div class="grid2">
        <div><h4>Where the CPU went, by area (self time)</h4>${hbar(s.areas.slice(0, 14).map((a) => ({ label: a.area, value: a.ms })), (v) => `${num(v / 1000, 2)}s · ${pct(v / Math.max(1, s.busyMs), 1)}`)}</div>
        <div><h4>Fest functions, inclusive time</h4><table class="data compact"><thead><tr><th>function</th><th>where</th><th>total</th><th>self</th></tr></thead><tbody>${s.festInclusive
          .map((f) => `<tr><td><code>${esc(f.fn)}</code></td><td class="loc">${esc(f.loc)}</td><td>${pct(f.totalMs / Math.max(1, s.busyMs), 1)}</td><td>${pct(f.selfMs / Math.max(1, s.busyMs), 1)}</td></tr>`)
          .join("")}</tbody></table></div>
      </div>
      <h4>Top functions by self time</h4>
      <table class="data compact"><thead><tr><th>function</th><th>where</th><th>area</th><th>self</th><th>% busy</th></tr></thead><tbody>${s.topSelf
        .map((f) => `<tr><td><code>${esc(f.fn)}</code></td><td class="loc">${esc(f.loc)}</td><td>${esc(f.area)}</td><td>${num(f.selfMs, 0)}ms</td><td>${pct(f.selfMs / Math.max(1, s.busyMs), 1)}</td></tr>`)
        .join("")}</tbody></table>
    </details>`;
  };
  return `<h3>CPU profiles</h3>
    <p class="muted">From a separate pass at a constant ${r.profiledAt === null ? "" : `${num(r.profiledAt)} developers`}, with <code>node --cpu-prof</code> in every gateway process (boot included). Profiling inflates event-loop utilisation, so it is kept out of the numbers above. Percentages are of each process's busy (non-idle) time.</p>
    ${http.map((p, i) => block(p, i === 0)).join("")}${primary.map((p) => block(p, false)).join("")}`;
}

function runSection(r: RunResult, res: BenchResult): string {
  return `<section class="run" id="run-${r.workers}">
    <h2><span class="dot" style="background:${colorOf(res.runs, r)}"></span>${esc(r.label)}</h2>
    ${r.warnings.length ? `<div class="warn"><b>Warnings</b><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
    ${r.persisted ? `<p>Database check: <b>${num(r.persisted.ok)}</b> ok rows written for <b>${num(r.persisted.turnsOk)}</b> completed streaming turns (${num(r.persisted.rows)} rows in total) — ${r.persisted.match ? '<span class="good">every completed turn persisted</span>' : '<span class="bad">MISMATCH</span>'}. Gateway exit code: ${r.gatewayExit ?? "—"}.</p>` : `<p class="muted">The load generators talk straight to the fake upstream: this is the floor the bench itself contributes to every number.</p>`}
    ${stageTable(r, res)}
    ${timelines(r, res)}
    ${profiles(r)}
  </section>`;
}

function environment(res: BenchResult): string {
  const m = res.meta;
  const p = res.params;
  const rows: Array<[string, string]> = [
    ["commit", `${m.git}${m.dirty ? " (dirty)" : ""} · fest ${m.festVersion}`],
    ["started", `${m.startedAt} · ${num(m.durationS)}s`],
    ["runtime", `Node ${m.node} · SQLite ${m.sqlite}`],
    ["machine", `${m.cpu} · ${m.cores} cores · ${m.memGb} GB · ${m.os}`],
    ["stages", `${p.stages.join(", ")} developers · ${p.stageSeconds}s each (first ${p.warmupSeconds}s excluded)`],
    ["turn shape", `TTFB ${p.shape.ttfbMs}ms, ${p.shape.chunks} chunks every ${p.shape.chunkIntervalMs}ms (${p.shape.chunkChars} chars) · request body ${p.bodyKb} KB · think ${p.thinkMs}ms ±50%`],
    ["mix", `passthrough ${p.mix.sub} · routed ${p.mix.route} · count_tokens ${p.mix.count}`],
    ["alongside", `${p.dashboards} dashboard poller(s) every ~${p.pollMs}ms · ${p.live} live-feed subscriber(s)`],
    ["fixture", `${num(m.historyRows)} history rows over ${p.historyDays} days · ${num(Math.max(...p.stages))} identity tokens`],
    ["bench", `${p.genProcs} generator process(es) + 1 fake upstream, same machine · profiling ${p.profile ? "on" : "off"}`],
    ["SLO", `chunk relay p99 ≤ ${p.slo.relayP99Ms}ms · TTFB overhead p99 ≤ ${p.slo.ttfbOverheadP99Ms}ms · errors ≤ ${(p.slo.errorRate * 100).toFixed(2)}%`],
  ];
  return `<table class="kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>`;
}

const CSS = `
:root{--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--bg:#fff;--soft:#f9fafb;--good:#15803d;--bad:#b91c1c}
*{box-sizing:border-box}body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg);margin:0}
main{max-width:1240px;margin:0 auto;padding:28px 24px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 10px;padding-top:16px;border-top:1px solid var(--line);display:flex;align-items:center;gap:8px}
h3{font-size:16px;margin:24px 0 8px}h4{font-size:13px;margin:14px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
.muted{color:var(--muted)}.good{color:var(--good);font-weight:600}.bad{color:var(--bad);font-weight:600}code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.dot{width:12px;height:12px;border-radius:50%;display:inline-block}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin:18px 0}
.card{border:1px solid var(--line);border-top:4px solid;border-radius:8px;padding:12px 14px;background:var(--soft)}
.cardtitle{font-weight:600}.big{font-size:28px;font-weight:700;margin:4px 0}.big small{display:block;font-size:12px;font-weight:400;color:var(--muted)}
.why{font-size:12px;color:var(--bad);margin:-2px 0 6px}.card dl{display:grid;grid-template-columns:1fr auto;gap:2px 8px;margin:0;font-size:12px}.card dt{color:var(--muted)}.card dd{margin:0;text-align:right}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(520px,1fr));gap:12px 20px}
.chart{margin:8px 0}.chart figcaption{font-weight:600;font-size:13px}.chart svg{width:100%;height:auto;overflow:visible}
.grid{stroke:#f0f1f3}.axis{stroke:#9ca3af}.ytick{font-size:10px;fill:var(--muted);text-anchor:end;dominant-baseline:middle}.xtick{font-size:10px;fill:var(--muted);text-anchor:middle}
.xlabel,.ylabel{font-size:11px;fill:var(--muted);text-anchor:middle}.slo{stroke:#dc2626;stroke-dasharray:4 4}.slolabel{font-size:10px;fill:#dc2626;text-anchor:end}
.band{fill:#f3f4f6}.bandlabel{font-size:9px;fill:#9ca3af;text-anchor:middle}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
table.data{border-collapse:collapse;width:100%;font-size:12px;margin:8px 0;font-variant-numeric:tabular-nums}table.data th,table.data td{padding:4px 6px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
table.data th{color:var(--muted);font-weight:600;background:var(--soft)}table.data td:first-child,table.data th:first-child{text-align:left}
table.data tr.fail td{background:#fef2f2}table.compact td.loc{color:var(--muted);text-align:left;max-width:340px;overflow:hidden;text-overflow:ellipsis}
table.compact td:nth-child(2),table.compact td:nth-child(3){text-align:left}
table.kv{border-collapse:collapse;font-size:13px}table.kv th{text-align:left;color:var(--muted);font-weight:500;padding:3px 16px 3px 0;vertical-align:top}table.kv td{padding:3px 0}
details{border:1px solid var(--line);border-radius:6px;padding:6px 12px;margin:8px 0;background:#fff}summary{cursor:pointer}
.hbar{font-size:12px}.hrow{display:grid;grid-template-columns:180px 1fr 120px;gap:8px;align-items:center;margin:2px 0}.hl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hb{background:#f3f4f6;height:12px;border-radius:2px}.hb i{display:block;height:100%;background:#2563eb;border-radius:2px}.hv{color:var(--muted);text-align:right}
.warn{background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:8px 14px;margin:10px 0}.warn ul{margin:4px 0 0;padding-left:18px}
.notes{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:10px 16px}.notes li{margin:3px 0}
nav a{margin-right:14px}
`;

export function renderReport(res: BenchResult): string {
  const fest = res.runs.filter((r) => r.workers > 0);
  const top = Math.max(0, ...fest.map((r) => r.maxHeld ?? 0));
  const best = fest.filter((r) => (r.maxHeld ?? 0) === top && top > 0);
  const firstFail = fest.map((r) => r.stages.find((s) => !s.held)).find((s) => s !== undefined);
  const verdict = fest.length === 0
    ? ""
    : best.length === 0
      ? `<p><b>No configuration met the SLO at any stage.</b>${firstFail ? ` The first failure: ${esc(firstFail.failed[0] ?? "")} at ${num(firstFail.developers)} developers.` : ""}</p>`
      : `<p>Best: <b>${best.map((r) => esc(r.label)).join(", ")}</b>${best.length > 1 ? " (tied)" : ""}, within SLO up to <b>${num(top)} simulated developers</b>.</p>`;
  const allWarn = [...(res.meta.warnings ?? []), ...res.runs.flatMap((r) => r.warnings.map((w) => `${r.label}: ${w}`))];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fest bench — ${esc(res.params.name)} — ${esc(res.meta.startedAt.slice(0, 10))}</title><style>${CSS}</style></head><body><main>
<h1>Fest performance — ${esc(res.params.name)}</h1>
<p class="muted">${esc(res.meta.startedAt.replace("T", " ").slice(0, 16))} UTC · ${esc(res.meta.git)}${res.meta.dirty ? " (dirty)" : ""} · ${esc(res.meta.cpu)}, ${res.meta.cores} cores · Node ${esc(res.meta.node)}</p>
${verdict}
${allWarn.length ? `<div class="warn"><b>${allWarn.length} warning(s)</b>${(res.meta.warnings ?? []).length ? `<ul>${(res.meta.warnings ?? []).map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""} — per-run warnings are listed with each run below.</div>` : ""}
${headline(res)}
<nav>${res.runs.map((r) => `<a href="#run-${r.workers}">${esc(r.label)}</a>`).join("")}<a href="#env">environment</a></nav>
<h2>Scaling</h2>
<ul class="notes">
<li><b>Chunk relay latency</b> is how late each streamed chunk reaches the client compared with when the upstream sent it, measured per chunk with a timestamp inside the payload. It is the number a developer feels as a stuttering stream, and the first to rise when an event loop is blocked.</li>
<li><b>TTFB overhead</b> is time to first byte minus the upstream's fixed ${res.params.shape.ttfbMs}ms. It includes reading a ${res.params.bodyKb} KB request body, identity lookup and routing.</li>
<li>A stage <b>holds</b> when it meets every SLO. "Developers within SLO" is the last stage before the first one that fails. The grey dashed line is the bench talking to the fake upstream with no Fest at all, which is the measurement floor.</li>
<li>Every process shares one machine with the load generators and the fake upstream, so absolute numbers depend on this hardware. Compare runs from the same machine.</li>
</ul>
${scaling(res)}
${res.runs.map((r) => runSection(r, res)).join("")}
<h2 id="env">Environment and parameters</h2>
${environment(res)}
<p class="muted">Generated by <code>npm run bench</code> (tools/bench). Re-render from the JSON with <code>npm run bench -- --render &lt;file&gt;.json</code>.</p>
</main></body></html>`;
}
