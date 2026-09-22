/**
 * The headline numbers for the window, eased rather than snapped.
 *
 * Every figure here is scoped to the rolling window, which is why none of them
 * are labelled as totals. The cost figure keeps the accounting rules it has
 * everywhere else: subscription usage is counted and never priced, and an
 * unpriceable request makes the figure a lower bound rather than being counted
 * as zero.
 */

import { useAnimatedNumber } from "../../hooks/useAnimatedNumber.ts";
import { tokens } from "../../lib/format.ts";

function Figure({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "ok" | "warn" | "bad";
}): React.JSX.Element {
  const toneClass =
    tone === "ok"
      ? "text-status-ok"
      : tone === "warn"
        ? "text-status-warn"
        : tone === "bad"
          ? "text-status-bad"
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
  tokensPerMinute,
  errorRatio,
  developers,
  subscriptionShare,
  serverKeyRequests,
}: {
  perMinute: number;
  tokensPerMinute: number;
  errorRatio: number | null;
  developers: number;
  subscriptionShare: number | null;
  serverKeyRequests: number;
}): React.JSX.Element {
  const rpm = useAnimatedNumber(perMinute);
  const tpm = useAnimatedNumber(tokensPerMinute);
  const devs = useAnimatedNumber(developers);
  const errPct = useAnimatedNumber((errorRatio ?? 0) * 100);
  const subPct = useAnimatedNumber((subscriptionShare ?? 0) * 100);

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
      <Figure label="Requests" value={`${rpm.toFixed(1)}`} note="per minute" />
      <Figure label="Tokens" value={tokens(Math.round(tpm))} note="per minute" />
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
