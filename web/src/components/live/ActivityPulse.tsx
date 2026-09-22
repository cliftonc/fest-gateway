/**
 * The rolling window, as stacked bars by model, scrolling continuously.
 *
 * The scroll is the point: a strip that only moves when a request arrives
 * cannot distinguish "quiet" from "stopped", which is the single most important
 * distinction on a monitoring surface. So the time axis advances every frame
 * whether or not anything is happening.
 *
 * Two details keep it from juddering, and both matter:
 *
 *  - Buckets are keyed on ABSOLUTE time (`floor(at / sliceMs)`), never on age
 *    relative to now. Bucketing by age re-cuts every bar each time the data
 *    changes, so bars twitch by up to a slice width on every rebuild.
 *  - Bar positions and the per-frame transform are both measured from the same
 *    captured `anchor`, so a rebuild lands exactly where the previous frame
 *    left off instead of snapping back.
 *
 * React re-renders only when the data changes; the scroll is one transform
 * write per frame on a single group.
 */

import { useLayoutEffect, useMemo, useRef } from "react";
import type { LiveEvent } from "../../hooks/useLiveWindow.ts";
import {
  emptyTally,
  formatAmount,
  isLowerBound,
  magnitude,
  tallyAdd,
  unitCaption,
  unitShort,
  zeroReason,
  type Measure,
  type MeasureTally,
} from "../../lib/measure.ts";

const VIEW_W = 600;
const VIEW_H = 72;
/** Headroom above the tallest bar, so the peak gridline is not the frame. */
const TOP_PAD = 8;
/** Enough bars to read as a texture, few enough to stay legible. */
const SLICES = 72;
/** Drawn past the left edge so bars scroll out rather than vanishing. */
const OVERSCAN = 1.25;

/**
 * Top models get the categorical ramp; the tail shares one muted colour.
 *
 * `--model-*` is a separate palette from the token-bucket greens on purpose —
 * see the note in styles.css. The two appear within a few hundred pixels of
 * each other and must never be confusable.
 */
export function modelColor(rank: number): string {
  return rank < 5 ? `var(--model-${rank + 1})` : "var(--muted-foreground)";
}

interface Bar {
  readonly key: number;
  readonly x: number;
  readonly segments: readonly { model: string; y: number; h: number }[];
}

export function ActivityPulse({
  events,
  windowMs,
  models,
  live,
  measure,
}: {
  events: readonly LiveEvent[];
  windowMs: number;
  /** Ranked top-first; index decides colour, so it must match the legend. */
  models: readonly string[];
  /** Paused or disconnected freezes the scroll — motion would imply flow. */
  live: boolean;
  /** What a bar's height means. Tokens, billed spend, or value at list rates. */
  measure: Measure;
}): React.JSX.Element {
  const scrollRef = useRef<SVGGElement | null>(null);

  const { bars, barW, anchor, peak, peakTally, sliceMs } = useMemo(() => {
    const now = Date.now();
    const sliceMs = windowMs / SLICES;
    const firstSlice = Math.floor((now - windowMs * OVERSCAN) / sliceMs);
    const lastSlice = Math.floor(now / sliceMs);

    /*
     * Absolute slice index → model → magnitude in the current measure.
     *
     * A slice also keeps its own tally, because the peak label has to know
     * whether the tallest bar is a lower bound. A single number could not say
     * so, and a `$0.0143` that is really "at least $0.0143" is the kind of
     * quietly-wrong figure the rest of this codebase goes out of its way to
     * avoid.
     */
    const grid = new Map<number, { byModel: Map<string, number>; tally: MeasureTally }>();
    for (const e of events) {
      const idx = Math.floor(e.at / sliceMs);
      if (idx < firstSlice || idx > lastSlice) continue;
      let cell = grid.get(idx);
      if (cell === undefined) {
        cell = { byModel: new Map<string, number>(), tally: emptyTally() };
        grid.set(idx, cell);
      }
      const one = emptyTally();
      tallyAdd(one, e);
      cell.byModel.set(e.model, (cell.byModel.get(e.model) ?? 0) + magnitude(one, measure));
      tallyAdd(cell.tally, e);
    }

    let max = 0;
    let peakTally = emptyTally();
    for (const cell of grid.values()) {
      let sum = 0;
      for (const v of cell.byModel.values()) sum += v;
      if (sum > max) {
        max = sum;
        peakTally = cell.tally;
      }
    }
    const scale = max === 0 ? 0 : (VIEW_H - TOP_PAD) / max;

    // Stack in the ranked model order so a model keeps its band as bars
    // arrive — a stack that reorders per bar is unreadable.
    const order = models.length > 0 ? models : [...new Set(events.map((e) => e.model))];

    const out: Bar[] = [];
    for (const [idx, cell] of grid) {
      const segments: { model: string; y: number; h: number }[] = [];
      let acc = 0;
      for (const model of order) {
        const v = cell.byModel.get(model);
        if (v === undefined || v === 0) continue;
        const h = v * scale;
        acc += h;
        segments.push({ model, y: VIEW_H - acc, h });
      }
      // Anything outside the ranked list still has to be drawn, or the bar
      // understates the traffic it represents.
      for (const [model, v] of cell.byModel) {
        if (order.includes(model)) continue;
        const h = v * scale;
        acc += h;
        segments.push({ model, y: VIEW_H - acc, h });
      }
      out.push({
        key: idx,
        x: VIEW_W * (1 + (idx * sliceMs - now) / windowMs),
        segments,
      });
    }

    return {
      bars: out,
      barW: Math.max(1.5, (VIEW_W * sliceMs) / windowMs - 1),
      anchor: now,
      peak: max,
      peakTally,
      sliceMs,
    };
  }, [events, windowMs, models, measure]);

  /**
   * A layout effect, not a passive one, and the first write is synchronous.
   *
   * On a rebuild React commits bars positioned against the NEW anchor while the
   * group still carries the transform computed against the old one. Waiting for
   * the next animation frame to correct that paints one frame at the wrong
   * offset — which is seen as the whole chart snapping back. Writing before the
   * browser paints means the two can never disagree.
   */
  useLayoutEffect(() => {
    const g = scrollRef.current;
    if (g === null) return;

    const apply = (): void => {
      const dx = ((Date.now() - anchor) / windowMs) * VIEW_W;
      g.setAttribute("transform", `translate(${(-dx).toFixed(2)} 0)`);
    };
    apply();

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    const tick = (): void => {
      apply();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [anchor, windowMs]);

  const colorOf = (model: string): string => {
    const i = models.indexOf(model);
    return modelColor(i === -1 ? 99 : i);
  };

  // The peak bar is drawn `TOP_PAD` from the top, so that is where the scale's
  // maximum sits. The axis itself does not scroll — only the bars do.
  const peakTopPct = (TOP_PAD / VIEW_H) * 100;

  const windowTally = useMemo(() => {
    const t = emptyTally();
    for (const e of events) tallyAdd(t, e);
    return t;
  }, [events]);
  const zero = zeroReason(windowTally, measure, events.length);

  return (
    <div
      className={`relative overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 transition-opacity ${
        live ? "" : "opacity-60"
      }`}
    >
      <div className="pointer-events-none absolute inset-0 z-10">
        {/* Boxed, because the bars scroll underneath these and unbacked text
            on top of a bar is unreadable at 10px. */}
        {peak > 0 && (
          <div
            className="absolute left-1.5 -translate-y-1/2 rounded bg-card/85 px-1 text-[10px] text-muted-foreground tabular-nums"
            style={{ top: `${peakTopPct}%` }}
          >
            {formatAmount(peak, measure, isLowerBound(peakTally, measure))}
          </div>
        )}
        <div className="absolute bottom-0.5 left-1.5 rounded bg-card/85 px-1 text-[10px] text-muted-foreground">
          0
        </div>
        <div className="absolute right-1.5 bottom-0.5 rounded bg-card/85 px-1 text-[10px] text-muted-foreground">
          {unitShort(measure)} per {Math.round(sliceMs / 1000)}s
        </div>

        {/*
          A flat strip is already what a zero window draws — `scale` guards the
          division and zero segments are skipped — so nothing here is broken.
          That is exactly the problem: on a subscription-only gateway in billed
          mode, "every request was absorbed" and "the gateway is idle" render
          identically, and only one of them is true.
        */}
        {zero !== null && (
          <div className="absolute inset-0 flex items-center justify-center px-6">
            <span className="rounded bg-card/85 px-1.5 py-0.5 text-center text-[11px] text-muted-foreground">
              {zero}
            </span>
          </div>
        )}
      </div>

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="h-[72px] w-full"
        role="img"
        aria-label={`${unitCaption(measure)} by model over the last ${Math.round(windowMs / 60_000)} minutes`}
      >
        <defs>
          {/* Dissolves bars leaving the window instead of clipping them. */}
          <linearGradient id="pulse-mask" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="black" />
            <stop offset="10%" stopColor="white" />
            <stop offset="100%" stopColor="white" />
          </linearGradient>
          <mask id="pulse-edge">
            <rect x="0" y="0" width={VIEW_W} height={VIEW_H} fill="url(#pulse-mask)" />
          </mask>
        </defs>

        <g mask="url(#pulse-edge)">
          <g ref={scrollRef}>
            {bars.map((b) => (
              <g key={b.key}>
                {b.segments.map((s) => (
                  <rect
                    key={s.model}
                    x={b.x}
                    y={s.y}
                    width={barW}
                    height={Math.max(1, s.h)}
                    fill={colorOf(s.model)}
                  />
                ))}
              </g>
            ))}
          </g>
        </g>

        {/* The scale, fixed while the bars scroll beneath it. */}
        {peak > 0 && (
          <line
            x1="0"
            y1={TOP_PAD}
            x2={VIEW_W}
            y2={TOP_PAD}
            stroke="var(--border)"
            strokeWidth="1"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <line
          x1="0"
          y1={VIEW_H - 0.5}
          x2={VIEW_W}
          y2={VIEW_H - 0.5}
          stroke="var(--border)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
