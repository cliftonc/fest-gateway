/**
 * The headline numbers for the window, eased rather than snapped.
 *
 * Every figure here is scoped to the rolling window, which is why none of them
 * are labelled as totals. The second one follows the page's measure — tokens,
 * billed spend, or value at list rates — and keeps the accounting rules that go
 * with it: subscription usage is counted and never priced, and an unpriceable
 * request makes the figure a lower bound rather than being counted as zero.
 */

import { useAnimatedNumber } from "../../hooks/useAnimatedNumber.ts";
import { formatAmount, rateLabels, type Measure } from "../../lib/measure.ts";

function Figure({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "ok" | "warn" | "bad" | "sub";
}): React.JSX.Element {
  const toneClass =
    tone === "ok"
      ? "text-status-ok"
      : tone === "warn"
        ? "text-status-warn"
        : tone === "bad"
          ? "text-status-bad"
          : tone === "sub"
            ? "text-status-sub"
            : "";
  return (
    <div className="rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10">
      <div className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {note !== undefined && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">{note}</div>
      )}
    </div>
  );
}

export function LiveStats({
  perMinute,
  measure,
  rate,
  rateLowerBound,
  errorRatio,
  developers,
  subscriptionShare,
  serverKeyRequests,
}: {
  perMinute: number;
  measure: Measure;
  /** The window's magnitude per minute, in the current measure. */
  rate: number;
  /** True when unpriced rows make that rate a floor rather than a figure. */
  rateLowerBound: boolean;
  errorRatio: number | null;
  developers: number;
  subscriptionShare: number | null;
  serverKeyRequests: number;
}): React.JSX.Element {
  const rpm = useAnimatedNumber(perMinute);
  const eased = useAnimatedNumber(rate);
  const devs = useAnimatedNumber(developers);
  const errPct = useAnimatedNumber((errorRatio ?? 0) * 100);
  const subPct = useAnimatedNumber((subscriptionShare ?? 0) * 100);

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
      <Figure label="Requests" value={`${rpm.toFixed(1)}`} note="per minute" />
      {/*
        A rate, not a window total. Every other figure in this row is a rate,
        and the window's totals already sit in the "who paid" panel below — so a
        total here would duplicate, where a burn rate is new information.
      */}
      <Figure
        label={rateLabels(measure).label}
        value={formatAmount(eased, measure, rateLowerBound)}
        note={rateLabels(measure).note}
        {...(measure === "value" ? { tone: "sub" as const } : {})}
      />
      <Figure
        label="Failing"
        value={errorRatio === null ? "—" : `${errPct.toFixed(0)}%`}
        note={errorRatio === null ? "no traffic yet" : "of this window"}
        {...(errorRatio !== null && errorRatio > 0 ? { tone: "bad" as const } : {})}
      />
      <Figure label="Developers" value={`${Math.round(devs)}`} note="active in window" />
      <Figure
        label="On own subscription"
        value={subscriptionShare === null ? "—" : `${subPct.toFixed(0)}%`}
        note={
          serverKeyRequests === 0
            ? "no org spend in window"
            : `${serverKeyRequests} on a server-held key`
        }
        {...(serverKeyRequests > 0 ? { tone: "warn" as const } : { tone: "ok" as const })}
      />
    </div>
  );
}
