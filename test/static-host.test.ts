/**
 * Static hosting for the dashboard bundle.
 *
 * Two things are load-bearing here and neither is about serving files:
 *
 *  1. Path traversal. The dashboard root sits next to the server source, so an
 *     escaped `..` reads this repository.
 *  2. The SPA fallback must NOT be a catch-all. An unknown `/v1/…` has to keep
 *     reaching the 404 in server.ts, because that warn line is the early
 *     warning that a Claude Code release added an endpoint. Answering it with
 *     an HTML page would hide exactly the signal it exists to raise.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticHost } from "../server/http/static.ts";

/**
 * A ServerResponse stand-in that is a REAL writable, because `serve()` ends in
 * `createReadStream(...).pipe(res)`.
 *
 * `settled()` matters as much as the writable does: the pipe outlives the
 * synchronous `serve()` call, so a test that returns without awaiting it leaves
 * a file handle opening against a fixture the teardown is about to delete. That
 * surfaces as a mysterious ENOENT rather than as a failed assertion.
 */
class FakeRes extends Writable {
  status: number | null = null;
  headers: Record<string, string> = {};
  override _write(_chunk: unknown, _enc: unknown, cb: () => void): void {
    cb();
  }
  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }
  settled(): Promise<void> {
    if (this.writableFinished) return Promise.resolve();
    return new Promise((resolve) => {
      this.once("finish", resolve);
      this.once("close", resolve);
      this.once("error", resolve);
    });
  }
}

const ROOT = mkdtempSync(join(tmpdir(), "fest-static-"));
mkdirSync(join(ROOT, "assets"), { recursive: true });
writeFileSync(join(ROOT, "index.html"), "<!doctype html><title>Fest</title>");
writeFileSync(join(ROOT, "assets", "index-abc123.js"), "console.log(1)");
after(() => rmSync(ROOT, { recursive: true, force: true }));

const host = createStaticHost(ROOT);

/** Serve one path and wait for the response to finish. */
async function serve(path: string): Promise<{ served: boolean; res: FakeRes }> {
  const res = new FakeRes();
  const served = host.serve(res as never, path);
  if (served) await res.settled();
  return { served, res };
}

test("an unbuilt dashboard is not an error — the gateway runs headless", () => {
  const absent = createStaticHost(join(tmpdir(), `fest-absent-${Date.now()}`));
  assert.equal(absent.available, false);
  assert.equal(absent.serve(new FakeRes() as never, "/"), false);
});

test("a real asset is served with its content type", async () => {
  const { served, res } = await serve("/assets/index-abc123.js");
  assert.equal(served, true);
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"] ?? "", /javascript/);
});

test("fingerprinted assets are immutable; index.html never is", async () => {
  const asset = await serve("/assets/index-abc123.js");
  assert.match(asset.res.headers["cache-control"] ?? "", /immutable/);

  const index = await serve("/");
  assert.equal(
    /immutable/.test(index.res.headers["cache-control"] ?? ""),
    false,
    "caching index.html makes a deploy invisible until the browser revalidates",
  );
});

test("client routes fall back to index.html", async () => {
  for (const path of ["/", "/overview", "/posture", "/users"]) {
    const { served, res } = await serve(path);
    assert.equal(served, true, path);
    assert.match(res.headers["content-type"] ?? "", /text\/html/, path);
  }
});

test("the fallback does not swallow the proxy or API surface", async () => {
  // These must reach server.ts's 404 — its warn line is how a new Claude Code
  // endpoint gets noticed before a developer hits it.
  for (const path of ["/v1/messages", "/v1/models", "/api/nope"]) {
    const { served } = await serve(path);
    assert.equal(served, false, path);
  }
});

test("a missing file with an extension 404s rather than returning the SPA", async () => {
  // Returning HTML for a missing .js is how you get "Unexpected token '<'".
  const { served } = await serve("/assets/gone.js");
  assert.equal(served, false);
});

test("path traversal cannot escape the bundle root", async () => {
  for (const path of [
    "/../../package.json",
    "/..%2f..%2fpackage.json",
    "/assets/../../package.json",
    "/%2e%2e/%2e%2e/package.json",
    "//etc/passwd",
    "/./../../server/config.ts",
  ]) {
    const { served, res } = await serve(path);
    // Either refused outright, or normalised to a client route and answered
    // with index.html — never with a file from outside the root.
    if (served) {
      assert.match(
        res.headers["content-type"] ?? "",
        /text\/html/,
        `${path} served something other than the SPA shell`,
      );
    }
  }
});

test("a malformed percent escape is refused, not thrown", async () => {
  const { served } = await serve("/%E0%A4%A");
  assert.equal(served, false);
});

test("a directory is not a file", async () => {
  // `/assets` exists but is a directory; it must fall through to the SPA shell
  // rather than trying to stream a directory.
  const { served, res } = await serve("/assets");
  assert.equal(served, true);
  assert.match(res.headers["content-type"] ?? "", /text\/html/);
});
