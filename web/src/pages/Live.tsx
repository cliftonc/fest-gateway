/**
 * Live feed: the tail, plus paged history behind it.
 *
 * Two sources, deliberately not merged into one list-in-a-ref:
 *
 *  - `/api/live` (SSE) pushes rows as the sink flushes them. These have no
 *    `seq`, because the flush happens before the rowid is read back.
 *  - `/api/requests` pages backwards on `seq`, which is stable under concurrent
 *    inserts in a way OFFSET is not.
 *
 * The live rows are held in their own state and rendered above the paged rows,
 * with anything already present in a fetched page filtered out by `id`. That
 * way neither source has to pretend to be the other, and a row cannot appear
 * twice as it crosses from one to the other.
 *
 * On every (re)connect the first page is invalidated, because the server keeps
 * no replay buffer: a client that was asleep has a hole in its tail, and the
 * paged endpoint is the only thing that can fill it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { LiveRowWire } from "../../../shared/api.ts";
import { api, type FeedFilters } from "../lib/api.ts";
import { subscribeLive } from "../lib/sse.ts";
import { FeedTable } from "../components/FeedTable.tsx";
import { Card, Muted, Pill, QueryState } from "../components/ui.tsx";
import { ORIGIN_LABELS } from "../lib/format.ts";

/** Cap the in-memory tail. A dashboard left open for a week must not grow. */
const MAX_LIVE = 200;
/** How long an arriving row is highlighted. */
const FLASH_MS = 1500;

export function LivePage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<FeedFilters>({});
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [live, setLive] = useState<readonly LiveRowWire[]>([]);
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(new Set());

  // Read inside the SSE callback without making the subscription depend on
  // them — re-subscribing on every filter change would drop and reopen the
  // stream, and lose whatever arrived in between.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const feed = useInfiniteQuery({
    queryKey: ["requests", filters],
    queryFn: ({ pageParam }) => api.requests(filters, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  /**
   * Client-side filtering for live rows only.
   *
   * The paged endpoint filters in SQL; the SSE stream is unfiltered, because a
   * per-subscriber filter on the server would put the dashboard's concerns
   * inside the metering path. Duplicating the predicate here is the cheaper
   * mistake — it is a handful of equality checks over at most a few rows per
   * flush.
   */
  const matches = useCallback((row: LiveRowWire, f: FeedFilters): boolean => {
    if (f.userId !== undefined && f.userId !== "" && row.userId !== f.userId) return false;
    if (f.model !== undefined && f.model !== "" && row.servedModel !== f.model) return false;
    if (
      f.credentialOrigin !== undefined &&
      f.credentialOrigin !== "" &&
      row.credentialOrigin !== f.credentialOrigin
    ) {
      return false;
    }
    if (f.errorsOnly === true && row.status === "ok") return false;
    return true;
  }, []);

  useEffect(() => {
    return subscribeLive({
      onStatus: setConnected,
      onReconnect: () => {
        // A gap may have opened while we were away; the paged view is the only
        // authority on what actually landed.
        void queryClient.invalidateQueries({ queryKey: ["requests"] });
      },
      onRows: (rows) => {
        if (pausedRef.current) return;
        const keep = rows.filter((r) => matches(r, filtersRef.current));
        if (keep.length === 0) return;
        setLive((prev) => [...keep].reverse().concat(prev).slice(0, MAX_LIVE));
        setNewIds(new Set(keep.map((r) => r.id)));
        setTimeout(() => setNewIds(new Set()), FLASH_MS);
      },
    });
  }, [queryClient, matches]);

  // Re-applying the predicate rather than clearing keeps the rows already in
  // hand when a filter narrows, which is what a reader expects.
  useEffect(() => {
    setLive((prev) => prev.filter((r) => matches(r, filters)));
  }, [filters, matches]);

  const pagedRows = useMemo(
    () => (feed.data?.pages ?? []).flatMap((p) => p.rows),
    [feed.data],
  );

  const rows = useMemo(() => {
    const seen = new Set(live.map((r) => r.id));
    return [...live, ...pagedRows.filter((r) => !seen.has(r.id))];
  }, [live, pagedRows]);

  return (
    <Card
      title="Requests"
      subtitle="Metadata only — model, tokens, timings and which credential served the call. Prompts and responses are never captured, so they cannot appear here."
      right={
        connected ? (
          <Pill tone={paused ? "warn" : "ok"}>{paused ? "paused" : "live"}</Pill>
        ) : (
          <Pill tone="warn">reconnecting…</Pill>
        )
      }
    >
      <div className="controls" style={{ marginBottom: 12 }}>
        <select
          value={filters.credentialOrigin ?? ""}
          onChange={(e) =>
            setFilters((f) => ({ ...f, credentialOrigin: e.target.value || undefined }))
          }
        >
          <option value="">All credentials</option>
          {Object.entries(ORIGIN_LABELS).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>

        <input
          placeholder="Filter by model id"
          value={filters.model ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, model: e.target.value || undefined }))}
        />

        <label className="check">
          <input
            type="checkbox"
            checked={filters.errorsOnly === true}
            onChange={(e) => setFilters((f) => ({ ...f, errorsOnly: e.target.checked || undefined }))}
          />
          Errors only
        </label>

        <button className={paused ? "active" : ""} onClick={() => setPaused((p) => !p)}>
          {paused ? "Resume" : "Pause"}
        </button>

        {live.length > 0 && (
          <button onClick={() => setLive([])}>Clear tail ({live.length})</button>
        )}
      </div>

      <QueryState
        isPending={feed.isPending}
        error={feed.error}
        isEmpty={rows.length === 0}
        emptyText="No requests recorded yet. Point Claude Code at this gateway and run a turn."
      >
        <FeedTable rows={rows} newIds={newIds} />

        <div className="controls" style={{ marginTop: 12 }}>
          <button
            onClick={() => void feed.fetchNextPage()}
            disabled={!feed.hasNextPage || feed.isFetchingNextPage}
          >
            {feed.isFetchingNextPage
              ? "Loading…"
              : feed.hasNextPage
                ? "Load older"
                : "No older requests"}
          </button>
          <Muted>
            {rows.length} shown
            {paused && " · paused, new requests are still being recorded"}
          </Muted>
        </div>
      </QueryState>
    </Card>
  );
}
