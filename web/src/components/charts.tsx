/**
 * The three charts, and only three.
 *
 * Everything drawn here is already aggregated server-side — hourly series,
 * fixed latency buckets, per-origin totals — so the library's job is drawing,
 * not computing. That is deliberate: a percentile computed in the browser from
 * a rollup row would be wrong (percentiles do not merge), and a chart library
 * cannot know that.
 *
 * Every definition is memoised on the data it captures, per the TanStack Charts
 * contract: a new definition identity is the signal to rebuild the scene, so an
 * unmemoised `defineChart` in a render body rebuilds on every keystroke.
 */

import { useMemo } from "react";
import { barX, barY, colorLegend, defineChart, stack } from "@tanstack/charts";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/charts/react";
import type { OverviewResponse } from "../../../shared/api.ts";
import { fillSeries } from "../../../shared/series.ts";
import { ORIGIN_LABELS, tokens } from "../lib/format.ts";

/**
 * Fixed hex rather than CSS custom properties: these values are also used for
 * the HTML legend swatches, and a chart whose colours resolve differently from
 * its legend is worse than one with no legend at all.
 */
const BUCKET_COLORS = ["#58a6ff", "#3fb950", "#a371f7", "#d29922"] as const;
const BUCKET_ORDER = ["Input", "Cache read", "Cache write 5m", "Cache write 1h"] as const;

export const ORIGIN_ORDER = [
  "inbound_subscription",
  "inbound_key",
  "fallback_server",
  "none",
] as const;

/**
 * Subscription is green and a server-held key is amber — not decoration.
 * `fallback_server` means the org paid instead of the developer's own plan, and
 * on this dashboard that is the event worth noticing.
 */
export const ORIGIN_COLORS: Readonly<Record<string, string>> = {
  inbound_subscription: "#3fb950",
  inbound_key: "#58a6ff",
  fallback_server: "#d29922",
  none: "#8b949e",
};

export function Legend({
  items,
}: {
  items: ReadonlyArray<{ label: string; color: string }>;
}): React.JSX.Element {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label}>
          <span className="swatch" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

// ── Hourly token traffic ──────────────────────────────────────────────────────

interface HourBucketRow {
  /**
   * The hour's epoch-ms start, NOT a formatted label.
   *
   * A clock label repeats every day, so over any range wider than 24 hours two
   * different hours collide on one band and the stack layout rejects the data
   * outright ("duplicate 19:00 / Input"). The key has to be unique; the axis
   * formats it back into something readable at draw time.
   */
  readonly hour: number;
  readonly bucket: string;
  readonly tokens: number;
}

/**
 * Hour-of-day for a dense axis, with the date where it changes so a multi-day
 * range does not read as one very long day.
 */
function hourTick(t: number, showDate: boolean): string {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  return showDate && d.getHours() === 0 ? `${d.getMonth() + 1}/${d.getDate()}` : hh;
}

export function TrafficChart({
  series,
  fromMs,
  toMs,
}: {
  series: OverviewResponse["series"];
  fromMs: number;
  toMs: number;
}): React.JSX.Element {
  // One row per (hour, bucket): the stack needs the four buckets as separate
  // rows sharing an hour key, not one row with four fields.
  const rows = useMemo(
    () =>
      fillSeries(series, fromMs, toMs, (hour, row): HourBucketRow[] => {
        const u = row?.usage;
        return [
          { hour, bucket: "Input", tokens: u?.inputTokens ?? 0 },
          { hour, bucket: "Cache read", tokens: u?.cacheReadTokens ?? 0 },
          { hour, bucket: "Cache write 5m", tokens: u?.cacheWrite5mTokens ?? 0 },
          { hour, bucket: "Cache write 1h", tokens: u?.cacheWrite1hTokens ?? 0 },
        ];
      }).flat(),
    [series, fromMs, toMs],
  );
  const multiDay = toMs - fromMs > 24 * 3_600_000;

  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          barY(rows, {
            x: "hour",
            y: "tokens",
            color: "bucket",
            // Explicit order: the four buckets are disjoint billing buckets and
            // the reader builds spatial memory for them. Letting the order fall
            // out of the data would reshuffle layers whenever a bucket is empty.
            layout: stack({ order: [...BUCKET_ORDER] }),
          }),
        ],
        scales: {
          x: {
            scale: () => scaleBand<number>().padding(0.2),
            // Thin the labels by pixel spacing rather than drawing one per
            // band: a 7-day range is 168 bands, and 168 labels is a smear.
            axis: {
              ticks: { spacing: 64, format: (v: number) => hourTick(v, multiDay) },
            },
          },
          y: {
            scale: scaleLinear,
            nice: true,
            grid: true,
            axis: { label: "Tokens", ticks: { format: (v: number) => tokens(v) } },
          },
        },
        color: {
          domain: [...BUCKET_ORDER],
          range: [...BUCKET_COLORS],
          legend: colorLegend({ label: "Bucket" }),
        },
        tooltip,
      }),
    [rows, multiDay],
  );

  return (
    <div className="chart">
      <Chart
        definition={definition}
        height={240}
        ariaLabel="Tokens per hour by billing bucket"
        ariaDescription="Stacked hourly token counts split into input, cache read, and 5-minute and 1-hour cache writes."
      />
    </div>
  );
}

// ── Credential posture ────────────────────────────────────────────────────────

/**
 * One stacked bar, because the question is a proportion: what share of this
 * org's traffic ran on a developer's own subscription rather than a key the
 * server holds. Four separate bars would answer "how many of each", which is
 * the count already shown in the table beneath it.
 */
export function PostureChart({
  rows,
}: {
  rows: OverviewResponse["byCredentialOrigin"];
}): React.JSX.Element {
  const data = useMemo(
    () =>
      [...rows]
        .filter((r) => r.requests > 0)
        .sort((a, b) => ORIGIN_ORDER.indexOf(a.credentialOrigin as never) -
          ORIGIN_ORDER.indexOf(b.credentialOrigin as never))
        .map((r) => ({
          lane: "Requests",
          origin: ORIGIN_LABELS[r.credentialOrigin] ?? r.credentialOrigin,
          requests: r.requests,
        })),
    [rows],
  );

  const present = useMemo(() => data.map((d) => d.origin), [data]);

  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          barX(data, {
            x: "requests",
            y: "lane",
            color: "origin",
            layout: stack({ order: present }),
            radius: 4,
          }),
        ],
        scales: {
          x: {
            scale: scaleLinear,
            nice: true,
            axis: { label: "Requests" },
          },
          y: { scale: () => scaleBand<string>().padding(0.55) },
        },
        color: {
          domain: present,
          range: present.map(
            (label) =>
              ORIGIN_COLORS[
                ORIGIN_ORDER.find((o) => ORIGIN_LABELS[o] === label) ?? "none"
              ] ?? "#8b949e",
          ),
        },
        tooltip,
      }),
    [data, present],
  );

  return (
    <div className="chart">
      <Chart
        definition={definition}
        height={96}
        ariaLabel="Requests by credential origin"
        ariaDescription="A single stacked bar showing what share of requests ran on a developer's own subscription versus a server-held key."
      />
    </div>
  );
}

// ── Latency histogram ─────────────────────────────────────────────────────────

export const LATENCY_LABELS = ["<1s", "1–3s", "3–10s", "10–30s", "30–60s", "≥60s"] as const;

/**
 * The six fixed buckets, drawn as they are stored.
 *
 * The top bucket is open-ended on purpose — an agent turn has a genuinely
 * unbounded tail — so it is labelled `≥60s` rather than given an invented upper
 * edge that a reader would take as real.
 */
export function LatencyChart({ buckets }: { buckets: readonly number[] }): React.JSX.Element {
  const data = useMemo(
    () => LATENCY_LABELS.map((label, i) => ({ label, count: buckets[i] ?? 0 })),
    [buckets],
  );

  const definition = useMemo(
    () =>
      defineChart({
        marks: [barY(data, { x: "label", y: "count", fill: "#58a6ff", radius: 3 })],
        scales: {
          x: { scale: () => scaleBand<string>().padding(0.25), axis: { label: "Duration" } },
          y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "Requests" } },
        },
        tooltip,
      }),
    [data],
  );

  return (
    <div className="chart">
      <Chart
        definition={definition}
        height={200}
        ariaLabel="Request duration histogram"
        ariaDescription="Request counts in six fixed duration buckets, from under one second to sixty seconds and over."
      />
    </div>
  );
}
