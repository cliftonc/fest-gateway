/**
 * Live feed subscription.
 *
 * `EventSource` rather than a fetch stream: it reconnects on its own, and a
 * dashboard left open overnight through a laptop sleep is the normal case, not
 * the edge case.
 *
 * Reconnection means frames can be MISSED — the server holds no replay buffer
 * (see `ingest/live-bus.ts`), so a client that was away has a hole in its tail.
 * That is why `onReconnect` exists: the feed page refetches its first page on
 * every (re)open rather than assuming the stream is a complete history. Treat
 * the live view as a tail and `/api/requests` as the record.
 */

import type { LiveFrame, LiveRowWire } from "../../../shared/api.ts";
import { appUrl } from "./base.ts";

export interface LiveHandlers {
  readonly onRows: (rows: readonly LiveRowWire[]) => void;
  /** Fired on every successful open, including reconnects. */
  readonly onReconnect?: (() => void) | undefined;
  readonly onStatus?: ((connected: boolean) => void) | undefined;
}

export function subscribeLive(handlers: LiveHandlers): () => void {
  const source = new EventSource(appUrl("api/live"));

  source.addEventListener("open", () => {
    handlers.onStatus?.(true);
    handlers.onReconnect?.();
  });

  source.addEventListener("error", () => {
    // EventSource retries by itself; reporting disconnected is all we do, so
    // the UI can say "reconnecting" instead of silently going stale.
    handlers.onStatus?.(false);
  });

  source.addEventListener("usage", (event) => {
    try {
      const frame = JSON.parse((event as MessageEvent<string>).data) as LiveFrame;
      if (frame.rows.length > 0) handlers.onRows(frame.rows);
    } catch {
      // A frame we cannot parse is a frame we skip. Never let the feed die on
      // one bad payload.
    }
  });

  return () => source.close();
}
