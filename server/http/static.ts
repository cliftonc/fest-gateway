/**
 * Static hosting for the built dashboard (`web/dist`).
 *
 * Optional by design: if the bundle has not been built, this returns false for
 * everything and the gateway runs headless. A proxy that refuses to start
 * because a dashboard asset is missing would be a self-inflicted outage on the
 * one path that must never go down.
 *
 * Path handling is the whole security surface here, so it is done once, at the
 * top: resolve the candidate and require the result to still be inside the
 * root. `..` in a URL, a percent-encoded `%2e%2e`, and an absolute path all
 * collapse to the same check rather than three separate ones that can disagree.
 *
 * The SPA fallback deliberately does NOT catch everything. An unknown
 * `/v1/whatever` must keep reaching the 404 in `server.ts`, because that warn
 * line is how a new Claude Code endpoint gets noticed before users hit it —
 * answering it with an HTML page would hide exactly the signal we built it for.
 */

import { createReadStream, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export interface StaticHost {
  readonly available: boolean;
  /** Returns false when the path is not ours, so the caller can 404 it. */
  serve(res: ServerResponse, path: string): boolean;
}

function fileSize(path: string): number | null {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * Point the document's `<base href>` at wherever Fest is actually mounted.
 *
 * The built bundle is emitted with `base: "./"`, so its asset URLs are already
 * relative; what they resolve *against* is this tag. Rewriting it here rather
 * than at build time is what keeps one artifact servable from `/` and from
 * `/fest` — including when a reader arrives at `/fest` with no trailing slash,
 * where the document's own URL would otherwise resolve `./assets/…` against
 * the origin root and 404.
 */
export function withBaseHref(html: string, basePath: string): string {
  const href = `${basePath}/`;
  const tag = `<base href="${href}" />`;
  // Test for the tag rather than comparing before/after: rewriting a document
  // that already carries the right href is a no-op, and reading that as "no tag
  // found" would append a second one on every serve.
  if (/<base\b[^>]*>/i.test(html)) return html.replace(/<base\b[^>]*>/i, tag);
  // No tag to rewrite (a hand-edited or third-party index.html). Insert one,
  // since a sub-path deployment is broken without it.
  return html.replace(/<head\b[^>]*>/i, (head) => `${head}\n    ${tag}`);
}

export function createStaticHost(rootDir: string, basePath = ""): StaticHost {
  const root = resolve(rootDir);
  const index = join(root, "index.html");
  const available = fileSize(index) !== null;

  /**
   * Read at request time, not cached at boot: `npm run dev` rebuilds the bundle
   * under a running server, and a cached copy would serve the previous deploy's
   * HTML until restart. It is ~1.5KB, and only the document hits this path.
   */
  function sendIndex(res: ServerResponse): boolean {
    let html: string;
    try {
      html = readFileSync(index, "utf8");
    } catch {
      return false;
    }
    const body = Buffer.from(withBaseHref(html, basePath), "utf8");
    res.writeHead(200, {
      "content-type": TYPES[".html"] ?? "text/html; charset=utf-8",
      "content-length": String(body.byteLength),
      "cache-control": "no-cache",
    });
    res.end(body);
    return true;
  }

  function send(res: ServerResponse, file: string, size: number, immutable: boolean): void {
    const ext = extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "content-length": String(size),
      // Vite fingerprints everything under /assets/, so those are safe to cache
      // forever. index.html must never be, or a deploy is invisible until the
      // browser feels like revalidating.
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    createReadStream(file).pipe(res);
  }

  return {
    available,

    serve(res: ServerResponse, path: string): boolean {
      if (!available) return false;

      let decoded: string;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        // A malformed escape is not a file request; let it 404 normally.
        return false;
      }

      const candidate = resolve(join(root, normalize(decoded)));
      // `startsWith(root + sep)` and not `startsWith(root)`: the latter would
      // also accept a sibling directory named `dist-backup`.
      const inRoot = candidate === root || candidate.startsWith(root + sep);

      if (inRoot) {
        // index.html goes through sendIndex wherever it is asked for, so a
        // direct request for it cannot bypass the <base href> rewrite that the
        // fallback below applies.
        if (candidate === index) return sendIndex(res);
        const size = fileSize(candidate);
        if (size !== null) {
          send(res, candidate, size, candidate.startsWith(join(root, "assets") + sep));
          return true;
        }
      }

      // SPA fallback: extensionless, non-API, non-proxy paths are client routes.
      if (extname(decoded) === "" && !decoded.startsWith("/v1/") && !decoded.startsWith("/api/")) {
        return sendIndex(res);
      }

      return false;
    },
  };
}
