/**
 * Zero-filling a gapped hourly series.
 *
 * The API returns gaps AS GAPS: an hour with no traffic is absent, not zero,
 * because the server cannot tell "nobody worked" from "outside retention",
 * whereas the caller knows exactly which range it asked for. Filling is
 * therefore the caller's job, and this is that job done once.
 *
 * It lives in `shared/` rather than in the chart component for one reason: the
 * bug it guards against is invisible in a component test and obvious in a unit
 * test. The hour KEY must be the epoch-ms hour start, never a formatted clock
 * label — a label repeats every 24 hours, so on any range wider than a day two
 * different hours collide on one categorical band and a stacked layout rejects
 * the data outright. Format at draw time; key on time.
 */

export const HOUR_MS = 3_600_000;

/**
 * Hours drawn at most. Beyond this the bars are sub-pixel on any real screen,
 * so the extra columns cost layout time and communicate nothing.
 */
export const MAX_HOURS = 168;

/** Epoch-ms hour starts covering `[fromMs, toMs]`, oldest first. */
export function hourStarts(fromMs: number, toMs: number, maxHours = MAX_HOURS): number[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];

  const lastHour = Math.floor(toMs / HOUR_MS) * HOUR_MS;
  const firstHour = Math.floor(fromMs / HOUR_MS) * HOUR_MS;
  const available = Math.floor((lastHour - firstHour) / HOUR_MS) + 1;
  const count = Math.min(available, maxHours);

  // When the range is longer than the cap, keep the RECENT end. A truncated
  // chart that drops the last hour would be actively misleading on a dashboard
  // whose whole job is "what is happening now".
  const start = lastHour - (count - 1) * HOUR_MS;

  const hours: number[] = [];
  for (let t = start; t <= lastHour; t += HOUR_MS) hours.push(t);
  return hours;
}

/**
 * Join a gapped series onto a dense hour axis.
 *
 * `fill` supplies the value for an hour with no row, so callers never have to
 * decide whether a missing hour is zero — here it genuinely is zero traffic,
 * which is different from an unpriced or unavailable figure elsewhere.
 */
export function fillSeries<TRow extends { readonly hourStart: number }, TOut>(
  rows: readonly TRow[],
  fromMs: number,
  toMs: number,
  project: (hourStart: number, row: TRow | undefined) => TOut,
  maxHours = MAX_HOURS,
): TOut[] {
  const byHour = new Map(rows.map((r) => [r.hourStart, r]));
  return hourStarts(fromMs, toMs, maxHours).map((t) => project(t, byHour.get(t)));
}
