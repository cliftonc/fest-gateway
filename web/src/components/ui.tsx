/**
 * The small set of presentational pieces every screen shares.
 *
 * These are thin wrappers over `components/ui/*` (shadcn) rather than direct
 * use of it, for the same reason they existed before shadcn did: their
 * consistency is the point. A `Stat` that renders `n/a` differently from a
 * `Cell` would quietly reintroduce the "is this zero or unknown" ambiguity the
 * whole dashboard is built to avoid, and keeping one wrapper per concept means
 * that rule has exactly one place to live.
 *
 * `title` props are rendered as real tooltips rather than the native attribute.
 * The credential trail is the clearest case: it is multi-line, it explains a
 * substitution, and on a native `title` it is unreachable by keyboard and
 * invisible on touch.
 */

import type { ReactNode } from "react";
import {
  Card as ShadCard,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card.tsx";
import { Badge } from "./ui/badge.tsx";
import { Progress } from "./ui/progress.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import {
  Table as ShadTable,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table.tsx";

export { TableRow, TableCell } from "./ui/table.tsx";

export type Tone = "ok" | "warn" | "bad" | "muted" | "info";

/** Tone → text colour, for the places that are not a badge. */
export const TONE_TEXT: Readonly<Record<Tone, string>> = {
  ok: "text-status-ok",
  warn: "text-status-warn",
  bad: "text-status-bad",
  info: "text-status-info",
  muted: "text-muted-foreground",
};

/**
 * Wrap a node in a tooltip, but only when there is something to say. Callers
 * pass an optional `title`, and a tooltip with no content is worse than none —
 * it is an empty black box that follows the pointer.
 */
function withTooltip(node: React.JSX.Element, title: string | undefined): React.JSX.Element {
  if (title === undefined || title === "") return node;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{node}</TooltipTrigger>
      <TooltipContent className="whitespace-pre-line">{title}</TooltipContent>
    </Tooltip>
  );
}

export function Card({
  title,
  subtitle,
  right,
  children,
}: {
  title?: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <ShadCard className="mb-4">
      {(title !== undefined || right !== undefined) && (
        <CardHeader>
          {title !== undefined && <CardTitle>{title}</CardTitle>}
          {subtitle !== undefined && (
            <CardDescription className="max-w-[70ch] text-xs">{subtitle}</CardDescription>
          )}
          {right !== undefined && <CardAction>{right}</CardAction>}
        </CardHeader>
      )}
      <CardContent>{children}</CardContent>
    </ShadCard>
  );
}

export function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: "ok" | "warn" | "bad" | "muted";
}): React.JSX.Element {
  return (
    <div>
      <div className="text-[11.5px] tracking-wide text-muted-foreground uppercase">{label}</div>
      <div
        className={`mt-0.5 text-xl font-semibold ${tone === undefined ? "" : TONE_TEXT[tone]}`}
      >
        {value}
      </div>
      {note !== undefined && <div className="mt-0.5 text-[11.5px] text-muted-foreground">{note}</div>}
    </div>
  );
}

export const StatRow = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3.5">{children}</div>
);

export function Pill({
  children,
  tone = "muted",
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string | undefined;
}): React.JSX.Element {
  return withTooltip(<Badge variant={tone}>{children}</Badge>, title);
}

/** A horizontal proportion bar. Used where a chart would be overkill. */
export function Meter({
  value,
  tone = "info",
  label,
}: {
  value: number | null;
  tone?: "ok" | "warn" | "bad" | "info";
  label?: string;
}): React.JSX.Element {
  // An unknown utilisation is not a zero-length bar. Saying so in words is the
  // only honest rendering.
  if (value === null || !Number.isFinite(value)) {
    return <span className="text-muted-foreground">n/a</span>;
  }
  const clamped = Math.max(0, Math.min(1, value));
  const fill: Readonly<Record<"ok" | "warn" | "bad" | "info", string>> = {
    ok: "[&_[data-slot=progress-indicator]]:bg-status-ok",
    warn: "[&_[data-slot=progress-indicator]]:bg-status-warn",
    bad: "[&_[data-slot=progress-indicator]]:bg-status-bad",
    info: "[&_[data-slot=progress-indicator]]:bg-status-info",
  };
  return (
    <Progress
      value={clamped * 100}
      aria-label={label ?? "utilisation"}
      className={`my-1 h-1.5 min-w-[90px] ${fill[tone]}`}
    />
  );
}

export const Muted = ({
  children,
  title,
}: {
  children: ReactNode;
  title?: string | undefined;
}): React.JSX.Element =>
  withTooltip(<span className="text-muted-foreground">{children}</span>, title);

/**
 * The three states every query screen has. Rendering them uniformly matters:
 * an empty table and a failed fetch look identical otherwise, and on a
 * monitoring tool "no traffic" and "monitoring is broken" must never be
 * confusable.
 */
export function QueryState({
  isPending,
  error,
  isEmpty,
  emptyText = "No traffic in this range.",
  children,
}: {
  isPending: boolean;
  error: unknown;
  isEmpty?: boolean;
  emptyText?: string;
  children: ReactNode;
}): React.JSX.Element {
  if (error !== null && error !== undefined) {
    return (
      <p className="py-3.5 text-status-bad">
        Could not load: {String((error as Error).message ?? error)}
      </p>
    );
  }
  if (isPending) {
    return (
      <div className="space-y-2 py-2" aria-busy="true" aria-live="polite">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-[85%]" />
        <Skeleton className="h-8 w-[70%]" />
      </div>
    );
  }
  if (isEmpty === true) return <p className="py-3.5 text-muted-foreground">{emptyText}</p>;
  return <>{children}</>;
}

export function Table({
  head,
  children,
}: {
  head: readonly string[];
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto">
      <ShadTable>
        <TableHeader>
          <TableRow>
            {head.map((h) => (
              <TableHead
                key={h}
                className="text-[11.5px] tracking-wide whitespace-nowrap uppercase"
              >
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </ShadTable>
    </div>
  );
}
