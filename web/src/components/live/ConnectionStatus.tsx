/**
 * Whether the feed is actually live, said loudly.
 *
 * On a monitoring surface, "no traffic" and "monitoring is broken" must never
 * be confusable — an idle feed and a dropped EventSource look identical if the
 * only difference is a word in small text. So the state gets motion: a pulsing
 * dot means frames are arriving, a still dot means they are not, and the
 * request rate is shown next to it so an empty-looking feed still has a number
 * proving the connection is alive.
 */

import { Pause, Wifi, WifiOff } from "lucide-react";

export function ConnectionStatus({
  connected,
  paused,
  perMinute,
}: {
  connected: boolean;
  paused: boolean;
  perMinute: number;
}): React.JSX.Element {
  const state = !connected ? "reconnecting" : paused ? "paused" : "live";

  const tone = {
    live: "text-status-ok",
    paused: "text-status-warn",
    reconnecting: "text-status-bad",
  }[state];

  const label = {
    live: "live",
    paused: "paused",
    reconnecting: "reconnecting…",
  }[state];

  return (
    <span className={`flex items-center gap-2 text-xs font-medium ${tone}`} role="status">
      <span className="relative flex size-2">
        {state === "live" && (
          // `motion-safe` only: a ring expanding twice a second is exactly the
          // kind of thing that makes a dashboard unusable for some readers.
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-70 motion-reduce:hidden" />
        )}
        <span className="relative inline-flex size-2 rounded-full bg-current" />
      </span>

      {state === "live" && <Wifi className="size-3.5" aria-hidden="true" />}
      {state === "paused" && <Pause className="size-3.5" aria-hidden="true" />}
      {state === "reconnecting" && <WifiOff className="size-3.5" aria-hidden="true" />}

      <span>{label}</span>

      {connected && (
        <span className="text-muted-foreground tabular-nums">
          {perMinute < 0.1 ? "idle" : `≈${perMinute.toFixed(1)}/min`}
        </span>
      )}
    </span>
  );
}
