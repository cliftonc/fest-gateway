/**
 * Live: what the gateway is doing right now, rolled up.
 *
 * Deliberately not a list of requests. A row per call is the wrong shape for
 * "what is happening" — by the time an operator has read three rows there are
 * twenty more, and the question they actually arrived with is which model,
 * which developer, and whose credential. So the window is aggregated and
 * ranked, and the individual rows stay in the database where the audit trail
 * needs them.
 *
 * Two sources feed one window:
 *
 *  - `/api/live` (SSE) pushes rows as the sink flushes them.
 *  - `/api/requests` seeds the window once on mount, because SSE only pushes
 *    what happens next and an operator opening this page during a quiet minute
 *    should not see an empty dashboard on a healthy gateway.
 *
 * On reconnect the seed is re-fetched: the server keeps no replay buffer, so a
 * client that was asleep has a hole and the paged endpoint is the only thing
 * that can fill it.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import { rangeFor } from "../lib/range.ts";
import { subscribeLive } from "../lib/sse.ts";
import { useLiveWindow, type LiveEvent } from "../hooks/useLiveWindow.ts";
import { isErrorStatus, type RequestStatus } from "../../../shared/types.ts";
import { ActivityPulse, modelColor } from "../components/live/ActivityPulse.tsx";
import { LiveControls } from "../components/live/LiveControls.tsx";
import { LiveStats } from "../components/live/LiveStats.tsx";
import { RollupBoard, type RollupEntry } from "../components/live/RollupBoard.tsx";
import { DeveloperAvatar } from "../components/live/DeveloperAvatar.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { costTotal, modelLabel, notionalTotal, originLabel, personLabel } from "../lib/format.ts";

const DEFAULT_WINDOW_MS = 300_000;

/** Roll the window up by some key, summing the things the boards draw. */
function rollup(
  events: readonly LiveEvent[],
  keyOf: (e: LiveEvent) => string,
): Map<string, { requests: number; errors: number; context: number; cacheWrite: number; output: number }> {
  const out = new Map<
    string,
    { requests: number; errors: number; context: number; cacheWrite: number; output: number }
  >();
  for (const e of events) {
    const k = keyOf(e);
    const cur = out.get(k) ?? { requests: 0, errors: 0, context: 0, cacheWrite: 0, output: 0 };
    cur.requests += 1;
    // The same predicate the writer and the query layer use, imported rather
    // than re-spelled — this was a third hand-written copy of `!== "ok"`, and
    // the live window disagreeing with the range below it is exactly the kind
    // of "which number do I believe" an operator cannot resolve on their own.
    if (isErrorStatus(e.status as RequestStatus)) cur.errors += 1;
    cur.context += e.context;
    cur.cacheWrite += e.cacheWrite;
    cur.output += e.output;
    out.set(k, cur);
  }
  return out;
}

const totalTokens = (v: { context: number; cacheWrite: number; output: number }): number =>
  v.context + v.cacheWrite + v.output;

export function LivePage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [windowMs, setWindowMs] = useState(DEFAULT_WINDOW_MS);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);

  const { window: win, add, seed } = useLiveWindow(windowMs);

  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const addRef = useRef(add);
  addRef.current = add;

  // The seed. Asks for enough rows to fill the longest window on offer; the
  // hook drops anything older than the window actually selected.
  const recent = useQuery({
    queryKey: ["requests", "live-seed"],
    queryFn: () => api.requests({}, null),
    staleTime: 15_000,
  });

  /**
   * Names for the ids the live rows carry.
   *
   * The SSE payload has a `userId` and no email — it is emitted from the
   * metering path, which has no business joining against the user table on
   * every flush. So the mapping is fetched once here instead, over a wide
   * range so that somebody quiet today is still named.
   */
  const identities = useQuery({
    queryKey: ["users", "identities"],
    queryFn: () => api.users(rangeFor("30d")),
    staleTime: 5 * 60_000,
  });

  const emailById = useMemo(
    () => new Map((identities.data?.rows ?? []).map((r) => [r.userId, r.email])),
    [identities.data],
  );

  const seedRef = useRef(seed);
  seedRef.current = seed;
  useEffect(() => {
    if (recent.data !== undefined) seedRef.current(recent.data.rows);
  }, [recent.data]);

  useEffect(() => {
    return subscribeLive({
      onStatus: setConnected,
      onReconnect: () => {
        void queryClient.invalidateQueries({ queryKey: ["requests", "live-seed"] });
      },
      onRows: (rows) => {
        // Pausing freezes the view, not the gateway. Dropping the rows here
        // rather than buffering them is deliberate: on resume the operator
        // wants to see what is happening now, not replay what they paused.
        if (pausedRef.current) return;
        addRef.current(rows);
      },
    });
  }, [queryClient]);

  const events = win.events;

  const byModel = useMemo<RollupEntry[]>(() => {
    const m = rollup(events, (e) => e.model);
    // Ranked here so the swatch a model gets on this board is the same colour
    // it has in the pulse above it.
    const ranked = [...m.entries()].sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]));
    return ranked.map(([model, v], i) => ({
      key: model,
      label: (
        <>
          <span
            className="inline-block size-2 shrink-0 rounded-sm"
            style={{ background: modelColor(i) }}
          />
          <span className="mono truncate text-xs" title={model === "" ? "unresolved" : model}>
            {modelLabel(model)}
          </span>
        </>
      ),
      value: totalTokens(v),
      requests: v.requests,
      context: v.context,
      cacheWrite: v.cacheWrite,
      output: v.output,
      errors: v.errors,
    }));
  }, [events]);

  const byUser = useMemo<RollupEntry[]>(() => {
    const m = rollup(events, (e) => e.userId ?? "");
    return [...m.entries()].map(([userId, v]) => {
      const id = userId === "" ? null : userId;
      const label = personLabel(id, emailById.get(userId) ?? null);
      return {
        key: userId === "" ? "unattributed" : userId,
        label: (
          <>
            <DeveloperAvatar userId={id} label={label} />
            <span className="truncate text-xs">{label}</span>
          </>
        ),
        value: totalTokens(v),
        requests: v.requests,
        context: v.context,
        cacheWrite: v.cacheWrite,
        output: v.output,
        errors: v.errors,
      };
    });
  }, [events, emailById]);

  /** Ranked top-first: the pulse colours its stack by this order. */
  const rankedModels = useMemo(
    () => [...byModel].sort((a, b) => b.value - a.value).map((m) => m.key),
    [byModel],
  );

  const byOrigin = useMemo(() => {
    const m = rollup(events, (e) => e.origin);
    return [...m.entries()]
      .map(([origin, v]) => ({ origin, ...v, total: totalTokens(v) }))
      .sort((a, b) => b.requests - a.requests);
  }, [events]);

  const stats = useMemo(() => {
    const minutes = windowMs / 60_000;
    const tokenSum = events.reduce((a, e) => a + e.context + e.cacheWrite + e.output, 0);
    const subscription = events.filter((e) => e.subscription).length;
    const serverKey = events.filter((e) => e.origin === "fallback_server").length;
    const developers = new Set(events.map((e) => e.userId ?? "")).size;

    // The same accounting rule the rest of the dashboard follows: only priced
    // rows are summed, unpriceable ones are counted so the figure can be shown
    // as the lower bound it is, and subscription usage is never given a price.
    const priced = events.filter((e) => !e.subscription && e.costUsd !== null);
    const unpriced = events.filter((e) => !e.subscription && e.costUsd === null).length;

    // Value runs on its own books: subscription rows are EXCLUDED above and
    // INCLUDED here, which is the whole reason both numbers are shown.
    const valued = events.filter((e) => e.notionalCostUsd !== null);

    return {
      perMinute: win.total / minutes,
      tokensPerMinute: tokenSum / minutes,
      errorRatio: win.errorRatio,
      developers,
      subscriptionShare: win.total === 0 ? null : subscription / win.total,
      serverKeyRequests: serverKey,
      spend: costTotal({
        pricedCostUsd: priced.reduce((a, e) => a + (e.costUsd ?? 0), 0),
        unpricedRequests: unpriced,
      }),
      value: notionalTotal({
        notionalCostUsd: valued.reduce((a, e) => a + (e.notionalCostUsd ?? 0), 0),
        notionalUnpricedRequests: events.length - valued.length,
      }),
      subscriptionRequests: subscription,
    };
  }, [events, win, windowMs]);

  return (
    <div className="flex flex-col gap-3">
      <LiveControls
        windowMs={windowMs}
        onWindowMs={setWindowMs}
        connected={connected}
        paused={paused}
        onPaused={setPaused}
        perMinute={stats.perMinute}
      />

      <ActivityPulse
        events={events}
        windowMs={windowMs}
        models={rankedModels}
        live={connected && !paused}
      />

      {rankedModels.length > 0 && (
        <div className="-mt-1 flex flex-wrap gap-x-4 gap-y-1 px-1">
          {rankedModels.slice(0, 5).map((m, i) => (
            <span key={m} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                className="inline-block size-2 rounded-sm"
                style={{ background: modelColor(i) }}
              />
              <span className="mono" title={m === "" ? "unresolved" : m}>
                {modelLabel(m)}
              </span>
            </span>
          ))}
          {rankedModels.length > 5 && (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                className="inline-block size-2 rounded-sm"
                style={{ background: modelColor(99) }}
              />
              {rankedModels.length - 5} more
            </span>
          )}
        </div>
      )}

      <LiveStats
        perMinute={stats.perMinute}
        tokensPerMinute={stats.tokensPerMinute}
        errorRatio={stats.errorRatio}
        developers={stats.developers}
        subscriptionShare={stats.subscriptionShare}
        serverKeyRequests={stats.serverKeyRequests}
      />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] gap-3">
        <RollupBoard
          title="By model"
          entries={byModel}
          emptyText="No traffic in this window yet."
        />
        <RollupBoard
          title="Top developers"
          entries={byUser}
          emptyText="No traffic in this window yet."
        />
      </div>

      <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-[11.5px] tracking-wide text-muted-foreground uppercase">
            Who paid, in this window
          </h2>
          <span className="text-[11px] text-muted-foreground">
            {stats.subscriptionRequests} absorbed by subscriptions
          </span>
        </div>

        {/*
          Both figures, adjacent and labelled, never summed. Billed is what the
          org owes; value is what the same window of work is worth at published
          API rates, subscription included. On a team running Max seats the
          first is near zero and the second is not — which is the number that
          makes the case for the gateway.
        */}
        <div className="mb-3 flex flex-wrap items-end gap-x-8 gap-y-2">
          <div>
            <div className="text-[11px] tracking-wide text-muted-foreground uppercase">Billed</div>
            <div className="num mt-0.5 text-xl font-semibold">{stats.spend}</div>
            <div className="text-[11px] text-muted-foreground">org spend</div>
          </div>
          <div>
            <div className="text-[11px] tracking-wide text-muted-foreground uppercase">
              Value at list rates
            </div>
            <div className="num mt-0.5 text-xl font-semibold text-status-sub">{stats.value}</div>
            <div className="text-[11px] text-muted-foreground">all usage, incl. subscription</div>
          </div>
        </div>

        {byOrigin.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            Nothing has run through the gateway in this window.
          </p>
        ) : (
          <>
            <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
              {byOrigin.map((o) => (
                <div
                  key={o.origin}
                  className={`transition-[width] duration-500 ease-out motion-reduce:transition-none ${
                    o.origin === "inbound_subscription"
                      ? "bg-status-ok"
                      : o.origin === "fallback_server"
                        ? "bg-status-warn"
                        : o.origin === "inbound_key"
                          ? "bg-status-info"
                          : "bg-muted-foreground"
                  }`}
                  style={{ width: `${(o.requests / Math.max(1, win.total)) * 100}%` }}
                />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {byOrigin.map((o) => (
                <span key={o.origin} className="flex items-center gap-1.5 text-[11px]">
                  <Badge
                    variant={
                      o.origin === "inbound_subscription"
                        ? "ok"
                        : o.origin === "fallback_server"
                          ? "warn"
                          : "muted"
                    }
                  >
                    {originLabel(o.origin)}
                  </Badge>
                  <span className="text-muted-foreground tabular-nums">{o.requests}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
