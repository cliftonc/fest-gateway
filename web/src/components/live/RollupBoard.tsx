/**
 * A live leaderboard: who or what is consuming the window, ranked.
 *
 * Rows are absolutely positioned by rank and moved with a transform, so when
 * the order changes they slide past each other instead of teleporting. That is
 * not decoration — on a live board, seeing a row overtake another is the
 * information; a list that silently reorders between glances just looks like
 * different data.
 *
 * Bar widths are a share of the window's leader, not of the total, because the
 * question these answer is "who is dominating right now".
 *
 * Each row carries a whole `MeasureTally` rather than a value and a label. The
 * measure decides which number the bar is as long as and which string the row
 * reads, and deriving both from one object is what stops them drifting apart:
 * a width computed in one measure beside a figure formatted in another is wrong
 * in a way nobody can see.
 */

import type { ReactNode } from "react";
import { useAnimatedNumber } from "../../hooks/useAnimatedNumber.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { num } from "../../lib/format.ts";
import {
  compareByMeasure,
  emptyTally,
  formatAmount,
  isLowerBound,
  magnitude,
  tallyMerge,
  unitCaption,
  zeroReason,
  type Measure,
  type MeasureTally,
} from "../../lib/measure.ts";

const ROW_H = 40;

/*
 * The bar is one solid length.
 *
 * It used to be split into context / cache write / output. On real traffic that
 * split is useless — Claude Code's context is one to two orders of magnitude
 * larger than what it writes or generates, so the other two bands render as
 * slivers a couple of pixels wide and the bar reads as solid anyway, just with
 * extra colours to explain. The breakdown moved to the tooltip, where a number
 * can say precisely what a two-pixel band could not.
 */

export interface RollupEntry {
  readonly key: string;
  readonly label: ReactNode;
  readonly requests: number;
  readonly errors: number;
  /** Every magnitude this row can be drawn at. The measure picks one. */
  readonly tally: MeasureTally;
}

function Row({
  entry,
  rank,
  peak,
  measure,
}: {
  entry: RollupEntry;
  rank: number;
  peak: number;
  measure: Measure;
}): React.JSX.Element {
  const value = magnitude(entry.tally, measure);
  const width = useAnimatedNumber(peak === 0 ? 0 : (value / peak) * 100);
  // NOTE: `useAnimatedNumber`'s epsilon is half a unit, so dollar figures snap
  // rather than tween. That is the right outcome — a tweening cent is
  // illegible — and is why the hook is left alone.
  const eased = useAnimatedNumber(value);

  return (
    <div
      className="absolute inset-x-0 flex h-10 items-center gap-3 px-1 transition-transform duration-500 ease-out motion-reduce:transition-none"
      style={{ transform: `translateY(${rank * ROW_H}px)` }}
    >
      <div className="flex w-[42%] min-w-0 items-center gap-2">{entry.label}</div>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="relative flex-1 cursor-default">
            <div className="h-5 overflow-hidden rounded-md bg-muted/60">
              <div
                className="h-full rounded-md bg-primary/80 transition-[width] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${width}%` }}
              />
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {/*
            The token split stays in every measure: it is true whatever the bar
            is drawn in, and it is the one thing a single bar can never show.

            The honesty counts appear only where they apply. `costTotal`'s own
            comment calls the unpriced count noise on a figure read at a glance,
            and it is right — but a tooltip is read deliberately, so this is
            where the `≥` gets to explain itself.
          */}
          <span className="flex flex-col gap-0.5">
            <span>Context {num(entry.tally.context)}</span>
            <span>Cache write {num(entry.tally.cacheWrite)}</span>
            <span>Output {num(entry.tally.output)}</span>
            <span className="text-background/70">
              {num(entry.requests)} request{entry.requests === 1 ? "" : "s"}
            </span>
            {measure === "billed" && entry.tally.subscriptionRequests > 0 && (
              <span className="text-background/70">
                {num(entry.tally.subscriptionRequests)} on subscription, never billed
              </span>
            )}
            {isLowerBound(entry.tally, measure) && (
              <span className="text-background/70">
                {num(
                  measure === "billed" ? entry.tally.billedUnpriced : entry.tally.valueUnpriced,
                )}{" "}
                not priced
              </span>
            )}
          </span>
        </TooltipContent>
      </Tooltip>

      <div className="w-24 shrink-0 text-right text-xs tabular-nums">
        {/*
          Not rounded. `Math.round` here was correct while this only ever showed
          tokens and catastrophic the moment it showed money: every figure under
          fifty cents would render as $0, which is the exact confusion between
          "free" and "small" that format.ts exists to prevent.
        */}
        <div className="font-medium">
          {formatAmount(eased, measure, isLowerBound(entry.tally, measure))}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {entry.requests} req
          {entry.errors > 0 && <span className="text-status-bad"> · {entry.errors} err</span>}
        </div>
      </div>
    </div>
  );
}

export function RollupBoard({
  title,
  entries,
  emptyText,
  measure,
  limit = 6,
}: {
  title: string;
  entries: readonly RollupEntry[];
  emptyText: string;
  measure: Measure;
  limit?: number;
}): React.JSX.Element {
  const top = [...entries].sort(compareByMeasure(measure)).slice(0, limit);
  const peak = top[0] === undefined ? 0 : magnitude(top[0].tally, measure);

  /*
   * Why a zero board is not an empty board.
   *
   * In billed mode on a gateway where everyone runs their own subscription —
   * Fest's happy path — every magnitude is 0. Falling through to `emptyText`
   * would say "No traffic in this window yet", which is a lie: the rows are
   * there, with their models, their request counts and their errors. It is the
   * money that is absent, and saying so is the useful answer.
   */
  const shown = emptyTally();
  let shownRequests = 0;
  for (const e of top) {
    tallyMerge(shown, e.tally);
    shownRequests += e.requests;
  }
  const zero = zeroReason(shown, measure, shownRequests);

  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[11.5px] tracking-wide text-muted-foreground uppercase">{title}</h2>
        <span className="text-[10px] text-muted-foreground">{unitCaption(measure)}</span>
      </div>

      {zero !== null && <p className="mb-2 text-[11px] text-muted-foreground">{zero}</p>}

      {top.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="relative" style={{ height: top.length * ROW_H }}>
          {top.map((e, i) => (
            <Row key={e.key} entry={e} rank={i} peak={peak} measure={measure} />
          ))}
        </div>
      )}
    </div>
  );
}
