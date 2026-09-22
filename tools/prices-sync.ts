/**
 * `npm run prices:sync` — regenerate the vendored price snapshot.
 *
 * Fetches litellm's price file, normalises it through the same
 * `normaliseCatalog` the runtime refresh uses, and writes
 * `server/usage/prices/snapshot.json.gz`.
 *
 * It prints a diff against the snapshot being replaced — models added, models
 * gone, rates changed — because the alternative is a 48KB binary blob in a pull
 * request that nobody can review. A rate change is a change to every dollar
 * figure Fest has ever shown; it should be read, not rubber-stamped.
 *
 * Run it whenever prices look stale. Nothing here runs in the server.
 */

import { gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LITELLM_URL, normaliseCatalog } from "../server/usage/prices/catalog.ts";
import type { ModelRate, PriceCatalog } from "../server/usage/prices/catalog.ts";
import { loadSnapshot } from "../server/usage/prices/table.ts";

const OUT = fileURLToPath(new URL("../server/usage/prices/snapshot.json.gz", import.meta.url));

function rateLine(r: ModelRate): string {
  return `in $${r.base.inputPerMillion}/M, out $${r.base.outputPerMillion}/M`;
}

function diff(before: PriceCatalog | null, after: PriceCatalog): void {
  if (before === null) {
    console.log(`no previous snapshot; writing ${Object.keys(after.models).length} models`);
    return;
  }

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [key, rate] of Object.entries(after.models)) {
    const old = before.models[key];
    if (old === undefined) added.push(key);
    else if (rateLine(old) !== rateLine(rate)) changed.push(`${key}: ${rateLine(old)} → ${rateLine(rate)}`);
  }
  for (const key of Object.keys(before.models)) {
    if (after.models[key] === undefined) removed.push(key);
  }

  console.log(`models: ${Object.keys(before.models).length} → ${Object.keys(after.models).length}`);
  // Rate changes are the ones a human must actually read, so they print in
  // full. Added/removed ids are noisy and rarely consequential, so they cap.
  if (changed.length > 0) console.log(`\nrate changes (${changed.length}):\n  ${changed.join("\n  ")}`);
  const cap = (xs: string[]) => (xs.length > 12 ? [...xs.slice(0, 12), `… and ${xs.length - 12} more`] : xs);
  if (added.length > 0) console.log(`\nadded (${added.length}):\n  ${cap(added).join("\n  ")}`);
  if (removed.length > 0) console.log(`\nremoved (${removed.length}):\n  ${cap(removed).join("\n  ")}`);
}

async function main(): Promise<void> {
  const url = process.argv[2] ?? LITELLM_URL;
  console.log(`fetching ${url}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  const catalog = normaliseCatalog(await res.json(), { source: url, fetchedAt: Date.now() });

  let before: PriceCatalog | null = null;
  try {
    before = loadSnapshot();
  } catch {
    // First run, or a snapshot this build cannot read. Either way, replace it.
  }
  diff(before, catalog);

  const gz = gzipSync(Buffer.from(JSON.stringify(catalog)), { level: 9 });
  writeFileSync(OUT, gz);
  console.log(`\nwrote ${OUT} (${(gz.byteLength / 1024).toFixed(1)} KB gzipped)`);
}

await main();
