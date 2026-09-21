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

import { createReadStream, statSync } from "node:fs";
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

export function createStaticHost(rootDir: string): StaticHost {
  const root = resolve(rootDir);
  const index = join(root, "index.html");
  const available = fileSize(index) !== null;

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
        const size = fileSize(candidate);
        if (size !== null) {
          send(res, candidate, size, candidate.startsWith(join(root, "assets") + sep));
          return true;
        }
      }

      // SPA fallback: extensionless, non-API, non-proxy paths are client routes.
      if (extname(decoded) === "" && !decoded.startsWith("/v1/") && !decoded.startsWith("/api/")) {
        const size = fileSize(index);
        if (size !== null) {
          send(res, index, size, false);
          return true;
        }
      }

      return false;
    },
  };
}
