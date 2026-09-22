/**
 * Build the publishable package into `dist/`.
 *
 * Three things have to end up there, and only the first is tsc's job:
 *
 *   1. The server, shared and cli TypeScript, emitted as JavaScript. An
 *      installed package cannot be TypeScript — see tsconfig.build.json.
 *   2. The non-TS runtime assets. Both are found relative to their own module
 *      (`import.meta.dirname` for the migrations, `import.meta.url` for the
 *      price snapshot), so they must sit beside the emitted JS, not beside the
 *      source.
 *   3. The built dashboard, at dist/web/dist — because server/http/server.ts
 *      resolves it as "../../web/dist" from its own location, which lands
 *      inside dist/ once the server itself does.
 */
import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dirname);
const dist = join(root, "dist");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const exists = async (p) => !!(await stat(p).catch(() => null));

await rm(dist, { recursive: true, force: true });

execFileSync(npx, ["tsc", "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });

/** Assets tsc does not know about, copied to the same path under dist/. */
const assets = ["server/store/migrations", "server/usage/prices/snapshot.json.gz"];
for (const rel of assets) {
  const from = join(root, rel);
  if (!(await exists(from))) throw new Error(`build-package: missing asset ${rel}`);
  await mkdir(dirname(join(dist, rel)), { recursive: true });
  await cp(from, join(dist, rel), { recursive: true });
}

// The dashboard is optional here only in the sense that `npm run build` may not
// have run yet; publishing without it would ship a gateway with no UI, so this
// is a hard failure rather than a warning.
const web = join(root, "web", "dist");
if (!(await exists(web))) {
  throw new Error("build-package: web/dist is missing — run `npm run build` first");
}
await cp(web, join(dist, "web", "dist"), { recursive: true });

console.log("build-package: dist/ ready");
