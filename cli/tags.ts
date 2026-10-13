/**
 * Request tags on the developer's side: which tags a `fest claude|codex|copilot`
 * session sends, and `fest tags` for the ones saved as defaults.
 *
 * Precedence, lowest first — a later layer overrides an earlier one per key,
 * and an empty value (`project=`) removes the key:
 *
 *   1. `project=<git repo name>`, when inside a repo
 *   2. global saved tags (`fest tags set -g team=platform`)
 *   3. saved tags for the current directory and each directory above it,
 *      outermost first (`fest tags set team=data` in `~/work` applies to every
 *      repo under it; `~/work/fest` can override that)
 *   4. `FEST_TAGS="team=platform,project=fest"`
 *   5. `--tag key=value` on the command line
 *
 * Saving is per-directory by default because tags describe the WORK — which
 * team, which project — and the directory is the closest thing a laptop has
 * to that. `-g` is for the few that follow the developer everywhere.
 *
 * The result rides in the `~…` path segment of the base URL each command
 * already builds (see `shared/tags.ts`), so one mechanism serves all three
 * clients — including Copilot on its own login, which cannot send headers.
 *
 * Saved tags live in their own file rather than in `config.json`: `fest login`
 * rewrites that file and `fest logout` deletes it, and neither should cost the
 * developer their team.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { CONFIG_DIR } from "./config.ts";
import {
  MAX_TAG_VALUE_LENGTH,
  formatTags,
  parseTagPairs,
  tagPathSegment,
  tagsFromPairs,
  type TagPair,
  type Tags,
} from "../shared/tags.ts";

export const TAGS_FILE = join(CONFIG_DIR, "tags.json");

/**
 * Peel leading `--tag key=value` / `--tag=key=value` flags off a command's
 * args. Leading only: everything after the first other argument belongs to
 * the child (`fest claude --tag project=x --resume`), and Fest must never eat
 * a flag the child was meant to see.
 */
export function peelTagFlags(argv: readonly string[]): { tags: string[]; rest: string[] } {
  const tags: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--tag") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--tag needs a value, e.g. --tag project=fest");
      tags.push(value);
      i += 2;
    } else if (arg.startsWith("--tag=")) {
      tags.push(arg.slice("--tag=".length));
      i += 1;
    } else {
      break;
    }
  }
  return { tags, rest: argv.slice(i) };
}

/**
 * A repo name as a tag value: characters the tag format refuses become `-`.
 * Null when nothing usable is left.
 */
export function repoTagValue(name: string): string | null {
  const cleaned = name
    .replace(/[^A-Za-z0-9 ._:@-]/g, "-")
    .trim()
    .slice(0, MAX_TAG_VALUE_LENGTH);
  return cleaned === "" ? null : cleaned;
}

/** The current git repo's directory name, or null outside a repo / without git. */
export function gitRepoName(cwd: string = process.cwd()): string | null {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return top === "" ? null : repoTagValue(basename(top));
  } catch {
    return null;
  }
}

/**
 * Saved tags: one global layer and one per directory. Values may be `""` — an
 * explicit "not here", which removes a key an outer layer set.
 */
export interface SavedTags {
  readonly global: Readonly<Record<string, string>>;
  /** Keyed by absolute, symlink-resolved directory. */
  readonly paths: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const EMPTY_SAVED: SavedTags = { global: {}, paths: {} };

/** Pure: the precedence chain above, given each layer's raw input. */
export function resolveTags(layers: {
  repo: string | null;
  saved: SavedTags;
  cwd: string;
  env: string | undefined;
  flags: readonly string[];
}): Record<string, string> {
  const pairs: TagPair[] = [];
  if (layers.repo !== null) pairs.push({ key: "project", value: layers.repo });
  pairs.push(...toPairs(layers.saved.global));
  for (const [, layer] of pathLayers(layers.saved, layers.cwd)) pairs.push(...toPairs(layer));
  if (layers.env !== undefined) pairs.push(...parseTagPairs(layers.env));
  for (const flag of layers.flags) {
    const parsed = parseTagPairs(flag);
    if (parsed.length === 0) throw new Error(`--tag ${flag}: expected key=value`);
    pairs.push(...parsed);
  }
  return tagsFromPairs(pairs);
}

const toPairs = (layer: Readonly<Record<string, string>>): TagPair[] =>
  Object.entries(layer).map(([key, value]) => ({ key, value }));

/** The saved directories that contain `cwd`, outermost first. */
export function pathLayers(
  saved: SavedTags,
  cwd: string,
): Array<[string, Readonly<Record<string, string>>]> {
  return Object.entries(saved.paths)
    .filter(([dir]) => cwd === dir || cwd.startsWith(dir.endsWith(sep) ? dir : dir + sep))
    .sort((a, b) => a[0].length - b[0].length);
}

/** Symlink-resolved, so `/tmp/x` and `/private/tmp/x` are one directory. */
export function canonicalDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** A layer from the (hand-editable) file, re-validated; empty values kept. */
function readLayer(v: unknown): Record<string, string> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") continue;
    for (const p of parseTagPairs(`${encodeURIComponent(k)}=${encodeURIComponent(val)}`)) out[p.key] = p.value;
  }
  return out;
}

export async function readSavedTags(): Promise<SavedTags> {
  let raw: string;
  try {
    raw = await readFile(TAGS_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_SAVED;
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_SAVED;
  const obj = parsed as Record<string, unknown>;
  // The first version of this file was a flat object of global tags.
  if (!("global" in obj) && !("paths" in obj)) return { global: readLayer(obj), paths: {} };
  const paths: Record<string, Record<string, string>> = {};
  if (obj["paths"] !== null && typeof obj["paths"] === "object") {
    for (const [dir, layer] of Object.entries(obj["paths"] as Record<string, unknown>)) {
      const l = readLayer(layer);
      if (Object.keys(l).length > 0) paths[dir] = l;
    }
  }
  return { global: readLayer(obj["global"]), paths };
}

async function writeSavedTags(saved: SavedTags): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(TAGS_FILE, JSON.stringify(saved, null, 2) + "\n", { mode: 0o600 });
}

/** Everything a client command needs: the tags, already resolved. */
export async function sessionTags(
  flags: readonly string[],
  cwd: string = process.cwd(),
): Promise<Record<string, string>> {
  return resolveTags({
    repo: gitRepoName(cwd),
    saved: await readSavedTags(),
    cwd: canonicalDir(cwd),
    env: process.env.FEST_TAGS,
    flags,
  });
}

/** `/~project=fest,team=platform`, or `""` — appended where a path may carry it. */
export function tagSuffix(tags: Tags): string {
  const seg = tagPathSegment(tags);
  return seg === "" ? "" : `/${seg}`;
}

/** One stderr line, so the developer can see what their usage is filed under. */
export function describeTags(tags: Tags): string {
  const s = formatTags(tags).replaceAll(",", ", ");
  return s === "" ? "no tags." : `tags ${decodeURIComponent(s)}.`;
}

/** `team=platform, project=(removed)` — a layer as the developer typed it. */
function showLayer(layer: Readonly<Record<string, string>>): string {
  const keys = Object.keys(layer).sort();
  return keys.length === 0 ? "(none)" : keys.map((k) => `${k}=${layer[k] === "" ? "(removed)" : layer[k]}`).join(", ");
}

/** `~/work/fest` rather than `/Users/someone/work/fest`. */
function showDir(dir: string): string {
  const home = canonicalDir(homedir());
  return dir === home ? "~" : dir.startsWith(home + sep) ? `~${dir.slice(home.length)}` : dir;
}

/**
 * `fest tags`                          saved layers that apply here, and the result
 * `fest tags set [-g] k=v [k=v …]`     save for this directory (or globally)
 * `fest tags unset [-g] k [k …]`       remove from this directory (or globally)
 */
export async function runTags(
  argv: readonly string[],
  opts: { out?: (line: string) => void; cwd?: string } = {},
): Promise<void> {
  const out = opts.out ?? ((s: string) => void process.stdout.write(`${s}\n`));
  const cwd = canonicalDir(opts.cwd ?? process.cwd());
  const global = argv.includes("-g") || argv.includes("--global");
  const [sub, ...rest] = argv.filter((a) => a !== "-g" && a !== "--global");
  const saved = await readSavedTags();
  const where = global ? "globally" : `for ${showDir(cwd)}`;
  const current = global ? saved.global : (saved.paths[cwd] ?? {});

  const store = async (layer: Record<string, string>): Promise<void> => {
    const paths = { ...saved.paths };
    if (!global) {
      if (Object.keys(layer).length === 0) delete paths[cwd];
      else paths[cwd] = layer;
    }
    await writeSavedTags({ global: global ? layer : saved.global, paths });
    out(`saved ${where}: ${showLayer(layer)}`);
  };

  if (sub === "set") {
    if (rest.length === 0) throw new Error("usage: fest tags set [-g] key=value [key=value …]");
    const next = { ...current };
    for (const arg of rest) {
      const parsed = parseTagPairs(arg);
      if (parsed.length === 0) throw new Error(`${arg}: expected key=value`);
      // An empty value is kept: here it means "not in this directory".
      for (const p of parsed) next[p.key] = p.value;
    }
    await store(next);
    return;
  }

  if (sub === "unset") {
    if (rest.length === 0) throw new Error("usage: fest tags unset [-g] key [key …]");
    const next = { ...current };
    for (const key of rest) delete next[key.toLowerCase()];
    await store(next);
    return;
  }

  if (sub !== undefined) throw new Error(`unknown \`fest tags ${sub}\`. Try \`fest tags set key=value\`.`);

  out(`global:    ${showLayer(saved.global)}`);
  for (const [dir, layer] of pathLayers(saved, cwd)) out(`${showDir(dir)}:  ${showLayer(layer)}`);
  const effective = await sessionTags([], cwd);
  out(`effective: ${decodeURIComponent(formatTags(effective)) || "(none)"}`);
  out("");
  out("`fest tags set` saves for this directory and everything under it; -g saves globally.");
  out("Effective also adds project=<git repo name> and FEST_TAGS. Override per session with");
  out("--tag key=value; an empty value (project=) removes a key.");
}
