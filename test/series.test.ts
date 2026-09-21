/**
 * Hourly zero-fill.
 *
 * The assertion that matters is uniqueness: the chart keys categorical bands on
 * these values, and a duplicate key makes a stacked layout throw rather than
 * mis-draw. That only happens on ranges wider than 24 hours, which is exactly
 * the case a quick look at a default dashboard never exercises.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HOUR_MS, fillSeries, hourStarts } from "../shared/series.ts";

const H = HOUR_MS;
const AT = 1_790_000_000_000;
const hour = (t: number): number => Math.floor(t / H) * H;

test("hour keys are unique across a multi-day range", () => {
  const hours = hourStarts(AT - 7 * 24 * H, AT);
  assert.equal(new Set(hours).size, hours.length);
  // The historical bug: keying on a clock label collapses 168 hours onto 24.
  assert.ok(hours.length > 24, "a 7-day range must not be flattened to one day");
});

test("hours are contiguous, ascending and one hour apart", () => {
  const hours = hourStarts(AT - 5 * H, AT);
  for (let i = 1; i < hours.length; i += 1) {
    assert.equal((hours[i] ?? 0) - (hours[i - 1] ?? 0), H);
  }
});

test("the range is covered inclusively at both ends", () => {
  const hours = hourStarts(AT - 3 * H, AT);
  assert.equal(hours[0], hour(AT - 3 * H));
  assert.equal(hours[hours.length - 1], hour(AT));
});

test("a range longer than the cap keeps the RECENT end", () => {
  const hours = hourStarts(AT - 400 * H, AT, 168);
  assert.equal(hours.length, 168);
  assert.equal(
    hours[hours.length - 1],
    hour(AT),
    "dropping the newest hour on a live dashboard would be the wrong truncation",
  );
});

test("a sub-hour range still yields one bucket", () => {
  assert.equal(hourStarts(AT, AT).length, 1);
});

test("an inverted or non-finite range yields nothing rather than throwing", () => {
  assert.deepEqual(hourStarts(AT, AT - H), []);
  assert.deepEqual(hourStarts(Number.NaN, AT), []);
  assert.deepEqual(hourStarts(AT - H, Number.POSITIVE_INFINITY), []);
});

test("missing hours are filled and present hours keep their row", () => {
  const rows = [{ hourStart: hour(AT), requests: 5 }];
  const filled = fillSeries(rows, AT - 2 * H, AT, (hourStart, row) => ({
    hourStart,
    requests: row?.requests ?? 0,
  }));

  assert.equal(filled.length, 3);
  assert.deepEqual(
    filled.map((f) => f.requests),
    [0, 0, 5],
    "a gap is zero traffic here — which is not the same as an unavailable figure",
  );
});

test("rows outside the range are ignored rather than appended", () => {
  const rows = [
    { hourStart: hour(AT) - 50 * H, requests: 99 },
    { hourStart: hour(AT), requests: 1 },
  ];
  const filled = fillSeries(rows, AT - H, AT, (hourStart, row) => ({
    hourStart,
    requests: row?.requests ?? 0,
  }));
  assert.equal(filled.length, 2);
  assert.equal(
    filled.reduce((a, f) => a + f.requests, 0),
    1,
  );
});
