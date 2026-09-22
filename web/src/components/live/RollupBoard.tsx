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
 */

import type { ReactNode } from "react";
import { useAnimatedNumber } from "../../hooks/useAnimatedNumber.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { num, tokens } from "../../lib/format.ts";

const ROW_H = 40;

/*
 * The bar is one solid length: total tokens.
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
  /** What the bar measures and the row is sorted by. */
  readonly value: number;
  readonly requests: number;
  /** Token split, drawn inside the bar. */
  readonly context: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly errors: number;
}

function Row({ entry, rank, peak }: { entry: RollupEntry; rank: number; peak: number }): React.JSX.Element {
  const width = useAnimatedNumber(peak === 0 ? 0 : (entry.value / peak) * 100);
  const value = useAnimatedNumber(entry.value);

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
          <span className="flex flex-col gap-0.5">
            <span>Context {num(entry.context)}</span>
            <span>Cache write {num(entry.cacheWrite)}</span>
            <span>Output {num(entry.output)}</span>
            <span className="text-background/70">
              {num(entry.requests)} request{entry.requests === 1 ? "" : "s"}
            </span>
          </span>
        </TooltipContent>
      </Tooltip>

      <div className="w-24 shrink-0 text-right text-xs tabular-nums">
        <div className="font-medium">{tokens(Math.round(value))}</div>
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
  limit = 6,
}: {
  title: string;
  entries: readonly RollupEntry[];
  emptyText: string;
  limit?: number;
}): React.JSX.Element {
  const top = [...entries].sort((a, b) => b.value - a.value).slice(0, limit);
  const peak = top[0]?.value ?? 0;

  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[11.5px] tracking-wide text-muted-foreground uppercase">{title}</h2>
        <span className="text-[10px] text-muted-foreground">total tokens</span>
      </div>

      {top.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="relative" style={{ height: top.length * ROW_H }}>
          {top.map((e) => (
            <Row key={e.key} entry={e} rank={top.indexOf(e)} peak={peak} />
          ))}
        </div>
      )}
    </div>
  );
}
