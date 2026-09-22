/**
 * The one refusal Fest does not count as a failure.
 *
 * The danger in this file is not that the predicate fails to match — it is that
 * it matches too much. A blanket "ignore 429s" would hide the single error an
 * operator most needs to see, so every test here is really asking: does a REAL
 * failure still get through?
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isWarmupPreflightRefusal } from "../server/pipeline/preflight.ts";
import { isErrorStatus, NON_ERROR_STATUSES } from "../shared/types.ts";

/** The observed shape, captured direct from api.anthropic.com. */
const REFUSAL = {
  httpStatus: 429,
  stream: false,
  maxTokens: 1,
  rateLimit: null,
  subscription: true,
} as const;

test("the captured warmup refusal is recognised", () => {
  assert.equal(isWarmupPreflightRefusal(REFUSAL), true);
});

test("a real rate limit is NOT — it arrives with quota headers", () => {
  assert.equal(
    isWarmupPreflightRefusal({
      ...REFUSAL,
      rateLimit: { status: "rejected", fiveHourUtilization: 1, fiveHourStatus: "rejected" },
    }),
    false,
    "the headers are the whole discriminator; without this the quota wall goes silent",
  );
});

test("a 429 on a real streaming turn is NOT", () => {
  assert.equal(isWarmupPreflightRefusal({ ...REFUSAL, stream: true }), false);
});

test("a 429 on real work is NOT, however small the request", () => {
  assert.equal(isWarmupPreflightRefusal({ ...REFUSAL, maxTokens: 64000 }), false);
  assert.equal(isWarmupPreflightRefusal({ ...REFUSAL, maxTokens: 2 }), false);
  assert.equal(
    isWarmupPreflightRefusal({ ...REFUSAL, maxTokens: null }),
    false,
    "an unparseable body is not an excuse to assume the benign case",
  );
});

test("a 429 on an org key is NOT — the same ping succeeds there, so its 429 is real", () => {
  assert.equal(isWarmupPreflightRefusal({ ...REFUSAL, subscription: false }), false);
});

test("only 429 — a 400 or 500 on the same ping is still a failure", () => {
  for (const httpStatus of [400, 401, 403, 500, 529]) {
    assert.equal(
      isWarmupPreflightRefusal({ ...REFUSAL, httpStatus }),
      false,
      `${httpStatus} must not be swallowed`,
    );
  }
});

// ── the shared predicate ──────────────────────────────────────────────────────

/**
 * `usage_hourly.errors` (the writer) and the raw-range SQL (the query layer)
 * are generated from this one list. If it ever grows a status that should have
 * counted, the same range reports different totals either side of the 2-hour
 * rollup threshold — a discrepancy that looks like a data bug and isn't.
 */
test("exactly two statuses are not failures, and everything else is", () => {
  assert.deepEqual([...NON_ERROR_STATUSES], ["ok", "preflight_refused"]);
  for (const status of [
    "client_abort",
    "stream_error",
    "upstream_error",
    "identity_denied",
    "bad_request",
  ] as const) {
    assert.equal(isErrorStatus(status), true, `${status} must count as an error`);
  }
  assert.equal(isErrorStatus("ok"), false);
  assert.equal(isErrorStatus("preflight_refused"), false);
});
