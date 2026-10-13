/**
 * The IPC vocabulary between a cluster primary and its HTTP workers.
 *
 * Small on purpose: everything a worker would otherwise share through memory
 * with the rest of the process. Usage flows up to the one writer; the live feed,
 * price reloads and the writer's own health flow back down to every worker.
 *
 * Sent with `serialization: "advanced"` (structured clone), so a record arrives
 * as the same shape it left, `null`s and nested objects included.
 */

import type { UsageRecord } from "../../shared/types.ts";
import type { SinkStats } from "../ingest/sink.ts";

export type ToPrimary =
  /** A worker's flushed batch, for the primary's sink to persist. */
  | { readonly t: "usage"; readonly records: readonly UsageRecord[] }
  /** An identity token was used; coalesced into `last_used_at` by the primary. */
  | { readonly t: "touch"; readonly tokenId: string };

export type ToWorker =
  /** Records the primary has just persisted, for each worker's live bus. */
  | { readonly t: "live"; readonly records: readonly UsageRecord[] }
  /** The price cache on disk is newer; re-read it. */
  | { readonly t: "prices" }
  /** The writer's sink health, so a dashboard on any worker can see drops. */
  | { readonly t: "stats"; readonly stats: SinkStats };

function tagged(m: unknown): string | null {
  if (typeof m !== "object" || m === null) return null;
  const t = (m as { t?: unknown }).t;
  return typeof t === "string" ? t : null;
}

export function isToPrimary(m: unknown): m is ToPrimary {
  const t = tagged(m);
  if (t === "usage") return Array.isArray((m as { records?: unknown }).records);
  if (t === "touch") return typeof (m as { tokenId?: unknown }).tokenId === "string";
  return false;
}

export function isToWorker(m: unknown): m is ToWorker {
  const t = tagged(m);
  if (t === "live") return Array.isArray((m as { records?: unknown }).records);
  if (t === "prices") return true;
  if (t === "stats") return typeof (m as { stats?: unknown }).stats === "object";
  return false;
}
