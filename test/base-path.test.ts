/**
 * Serving Fest from a sub-path (`https://host/fest`) rather than an origin root.
 *
 * Three separate mechanisms have to agree for that to work, and each is cheap
 * to break independently:
 *
 *  1. `normalizeBasePath` — one canonical shape, so everything downstream can
 *     write `${basePath}/x` and `startsWith(basePath)` with no root special case.
 *  2. `stripBasePath` — the prefix may or may not still be on the request,
 *     depending on whether the proxy stripped it. Both have to route.
 *  3. `withBaseHref` — the bundle's URLs are relative, so the `<base href>` is
 *     the single point that decides what they resolve against. Get it wrong and
 *     the dashboard loads its own HTML but none of its assets or API calls.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeBasePath } from "../server/config.ts";
import { stripBasePath } from "../server/http/server.ts";
import { createStaticHost, withBaseHref } from "../server/http/static.ts";

test("a base path is normalised to one leading slash and no trailing one", () => {
  for (const raw of ["/fest", "fest", "/fest/", "fest/", "//fest//", "  /fest/  "]) {
    assert.equal(normalizeBasePath(raw), "/fest", raw);
  }
  // The root deployment is the empty string, not "/", so `${basePath}/` is
  // always exactly one slash.
  for (const raw of ["", "/", "///", "   "]) {
    assert.equal(normalizeBasePath(raw), "", JSON.stringify(raw));
  }
});

test("a nested mount point survives normalisation", () => {
  assert.equal(normalizeBasePath("/tools/fest/"), "/tools/fest");
});

test("stripBasePath handles a proxy that did not strip the prefix", () => {
  assert.equal(stripBasePath("/fest/api/overview", "/fest"), "/api/overview");
  assert.equal(stripBasePath("/fest/v1/messages", "/fest"), "/v1/messages");
  assert.equal(stripBasePath("/fest/t/tok123/v1/messages", "/fest"), "/t/tok123/v1/messages");
});

test("stripBasePath leaves an already-stripped request alone", () => {
  // Caddy's handle_path and nginx's trailing-slash proxy_pass both strip, so
  // this is the other half of the same deployment working.
  assert.equal(stripBasePath("/api/overview", "/fest"), "/api/overview");
  assert.equal(stripBasePath("/v1/messages", "/fest"), "/v1/messages");
});

test("the bare mount point becomes a root request, not an empty path", () => {
  assert.equal(stripBasePath("/fest", "/fest"), "/");
  assert.equal(stripBasePath("/fest?x=1", "/fest"), "/?x=1");
});

test("stripBasePath only cuts at a segment boundary", () => {
  // `/festival` starts with `/fest` as a string but is a different path; cutting
  // it would route a stranger's URL into the dashboard.
  assert.equal(stripBasePath("/festival/api", "/fest"), "/festival/api");
  assert.equal(stripBasePath("/festing", "/fest"), "/festing");
});

test("stripBasePath is a no-op for the ordinary root deployment", () => {
  for (const url of ["/", "/api/overview", "/v1/messages", "/fest/api"]) {
    assert.equal(stripBasePath(url, ""), url, url);
  }
});

test("withBaseHref rewrites the tag the bundle ships with", () => {
  const html = '<!doctype html><html><head><base href="/" /><title>Fest</title></head></html>';
  assert.match(withBaseHref(html, "/fest"), /<base href="\/fest\/" \/>/);
  // The root case still produces a valid single-slash href.
  assert.match(withBaseHref(html, ""), /<base href="\/" \/>/);
});

test("withBaseHref inserts a tag when index.html has none", () => {
  const html = "<!doctype html><html><head><title>Fest</title></head></html>";
  const out = withBaseHref(html, "/fest");
  assert.match(out, /<base href="\/fest\/" \/>/);
  // Inserted inside <head>, and before the content it has to govern.
  assert.ok(out.indexOf("<base") < out.indexOf("<title>"), "base must precede relative URLs");
});

test("withBaseHref does not duplicate the tag on repeated serves", () => {
  const html = '<!doctype html><html><head><base href="/" /></head></html>';
  const once = withBaseHref(html, "/fest");
  assert.equal(withBaseHref(once, "/fest"), once);
  assert.equal(once.match(/<base/g)?.length, 1);
});

/** A ServerResponse stand-in; index.html is written with `res.end(buffer)`. */
class FakeRes extends Writable {
  status: number | null = null;
  headers: Record<string, string> = {};
  body = "";
  override _write(chunk: Buffer, _enc: unknown, cb: () => void): void {
    this.body += chunk.toString();
    cb();
  }
  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }
  settled(): Promise<void> {
    if (this.writableFinished) return Promise.resolve();
    return new Promise((r) => {
      this.once("finish", r);
      this.once("close", r);
    });
  }
}

const ROOT = mkdtempSync(join(tmpdir(), "fest-basepath-"));
mkdirSync(join(ROOT, "assets"), { recursive: true });
writeFileSync(
  join(ROOT, "index.html"),
  '<!doctype html><html><head><base href="/" /><title>Fest</title></head><body></body></html>',
);
writeFileSync(join(ROOT, "assets", "index-abc123.js"), "console.log(1)");
after(() => rmSync(ROOT, { recursive: true, force: true }));

async function serveFrom(host: ReturnType<typeof createStaticHost>, path: string): Promise<FakeRes> {
  const res = new FakeRes();
  const served = host.serve(res as never, path);
  assert.equal(served, true, path);
  await res.settled();
  return res;
}

test("a sub-path host serves index.html with the mount point baked in", async () => {
  const host = createStaticHost(ROOT, "/fest");
  // The proxy has already stripped `/fest`, so the request arrives at the root.
  const res = await serveFrom(host, "/");
  assert.equal(res.status, 200);
  assert.match(res.body, /<base href="\/fest\/" \/>/);
  assert.equal(res.headers["content-length"], String(Buffer.byteLength(res.body)));
});

test("a direct request for index.html cannot bypass the rewrite", async () => {
  // Without this the shell is reachable un-rewritten, and loads no assets.
  const host = createStaticHost(ROOT, "/fest");
  const res = await serveFrom(host, "/index.html");
  assert.match(res.body, /<base href="\/fest\/" \/>/);
});

test("the root deployment is unchanged", async () => {
  const host = createStaticHost(ROOT);
  const res = await serveFrom(host, "/");
  assert.match(res.body, /<base href="\/" \/>/);
});

test("assets are still served, and still immutable, under a sub-path", async () => {
  const host = createStaticHost(ROOT, "/fest");
  const res = await serveFrom(host, "/assets/index-abc123.js");
  assert.match(res.headers["cache-control"] ?? "", /immutable/);
  assert.match(res.headers["content-type"] ?? "", /javascript/);
});
