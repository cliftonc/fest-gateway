/**
 * The dev server's API proxy, guarded because getting it wrong breaks
 * authentication in a way that looks like a dead button rather than an error.
 *
 * The gateway's CSRF defence compares the browser's `Origin` against the
 * request's `Host` (`originAllowed` in server/auth/guard.ts). Vite's proxy can
 * rewrite Host, and if it does, those two permanently disagree: every POST is
 * answered 403 "cross-origin request refused", so sign-in and sign-out stop
 * working under `npm run dev` while OAuth — a GET, not origin-checked — keeps
 * working and hides the breakage.
 *
 * This is a configuration bug that no amount of server-side testing can catch,
 * which is exactly why it is asserted here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

test("the dev proxy does not rewrite Host, which would fail the origin check", async () => {
  const mod = (await import("../vite.config.ts")) as { default: unknown };
  const config = mod.default as {
    server?: { proxy?: Record<string, { changeOrigin?: boolean }> };
  };

  const api = config.server?.proxy?.["/api"];
  assert.ok(api !== undefined, "the dev server must proxy /api to the gateway");
  assert.notEqual(
    api.changeOrigin,
    true,
    "changeOrigin rewrites Host, which makes every dashboard POST 403 in dev",
  );
});
