/**
 * The small set of presentational pieces every screen shares.
 *
 * Kept in one file because they are each a few lines and their consistency is
 * the point: a `Stat` that renders `n/a` differently from a `Cell` would
 * quietly reintroduce the "is this zero or unknown" ambiguity the whole
 * dashboard is built to avoid.
 */

import type { ReactNode } from "react";

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
    <section className="card">
      {(title !== undefined || right !== undefined) && (
        <header className="card-head">
          <div>
            {title !== undefined && <h2>{title}</h2>}
            {subtitle !== undefined && <p className="sub">{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
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
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone === undefined ? "" : `tone-${tone}`}`}>{value}</div>
      {note !== undefined && <div className="stat-note">{note}</div>}
    </div>
  );
}

export const StatRow = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <div className="stat-row">{children}</div>
);

export function Pill({
  children,
  tone = "muted",
  title,
}: {
  children: ReactNode;
  tone?: "ok" | "warn" | "bad" | "muted" | "info";
  title?: string | undefined;
}): React.JSX.Element {
  return (
    <span className={`pill tone-${tone}`} title={title}>
      {children}
    </span>
  );
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
  if (value === null || !Number.isFinite(value)) {
    return <span className="muted">n/a</span>;
  }
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <div
      className="meter"
      role="meter"
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? "utilisation"}
    >
      <div className={`meter-fill tone-${tone}`} style={{ width: `${clamped * 100}%` }} />
    </div>
  );
}

export const Muted = ({
  children,
  title,
}: {
  children: ReactNode;
  title?: string | undefined;
}): React.JSX.Element => (
  <span className="muted" title={title}>
    {children}
  </span>
);

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
    return <p className="state bad">Could not load: {String((error as Error).message ?? error)}</p>;
  }
  if (isPending) return <p className="state muted">Loading…</p>;
  if (isEmpty === true) return <p className="state muted">{emptyText}</p>;
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
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
