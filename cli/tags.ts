/**
 * Request tags on the developer's side: which tags a `fest claude|codex|copilot`
 * session sends, and `fest tags` for the ones saved as defaults.
 *
 * Precedence, lowest first — a later layer overrides an earlier one per key,
 * and an empty value (`project=`) removes the key:
 *
 *   1. `project=<git repo name>`, when inside a repo
 *   2. global saved tags (`fest tags set -g team=platform`)
 *   3. directory layers containing the cwd, outermost first, so the narrowest
 *      wins: the repo's own file (below) and any directory saved in
 *      `~/.fest/tags.json` (`fest tags set team=data` in `~/work`, outside a
 *      repo, applies to every repo under it). The repo file wins a tie.
 *   4. `FEST_TAGS="team=platform,project=fest"`
 *   5. `--tag key=value` on the command line
 *
 * Inside a git repo, `fest tags set` writes to the repo itself — the `fest`
 * key of a root `package.json`, else `.fest.json` at the root — so the tags are
 * committed with the code and every clone picks them up with no setup. Tags
 * describe the WORK, and the repo is the work. Outside a repo it saves for the
 * directory in `~/.fest/tags.json`; `-g` is for the few that follow the
 * developer everywhere.
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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

/** The current git repo's root, symlink-resolved, or null outside a repo / without git. */
export function gitRoot(cwd: string = process.cwd()): string | null {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return top === "" ? null : canonicalDir(top);
  } catch {
    return null;
  }
}

/** The current git repo's directory name, or null outside a repo / without git. */
export function gitRepoName(cwd: string = process.cwd()): string | null {
  const root = gitRoot(cwd);
  return root === null ? null : repoTagValue(basename(root));
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

/** Tags committed to a repo, read from its root. */
export interface RepoTags {
  /** The repo root, symlink-resolved. */
  readonly dir: string;
  /** Root-relative names of the files they came from, for display. */
  readonly files: readonly string[];
  readonly tags: Readonly<Record<string, string>>;
}

/** Pure: the precedence chain above, given each layer's raw input. */
export function resolveTags(layers: {
  repo: string | null;
  saved: SavedTags;
  repoFile?: RepoTags | null;
  cwd: string;
  env: string | undefined;
  flags: readonly string[];
}): Record<string, string> {
  const pairs: TagPair[] = [];
  if (layers.repo !== null) pairs.push({ key: "project", value: layers.repo });
  pairs.push(...toPairs(layers.saved.global));
  for (const { layer } of dirLayers(layers.saved, layers.repoFile ?? null, layers.cwd)) pairs.push(...toPairs(layer));
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

/**
 * Every directory layer that applies at `cwd`, outermost first: the saved
 * directories containing it plus the repo's own file. Sorted by depth, so the
 * narrowest wins; the repo file sorts after a saved entry for the same
 * directory, because a committed file is the more deliberate statement.
 */
export function dirLayers(
  saved: SavedTags,
  repoFile: RepoTags | null,
  cwd: string,
): Array<{ dir: string; files: readonly string[] | null; layer: Readonly<Record<string, string>> }> {
  const out: Array<{ dir: string; files: readonly string[] | null; layer: Readonly<Record<string, string>> }> =
    pathLayers(saved, cwd).map(([dir, layer]) => ({ dir, files: null, layer }));
  if (repoFile !== null && Object.keys(repoFile.tags).length > 0) {
    out.push({ dir: repoFile.dir, files: repoFile.files, layer: repoFile.tags });
  }
  // Stable, so a tie keeps the repo file (pushed last) on top.
  return out.sort((a, b) => a.dir.length - b.dir.length);
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

export const PACKAGE_JSON = "package.json";
export const FEST_JSON = ".fest.json";

/** A JSON object from `path`, null when the file is absent. */
async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * The tags committed at a repo root: `package.json`'s `fest` key, then
 * `.fest.json` over it. Both are read, so a `.fest.json` keeps working after
 * the repo later gains a `package.json`.
 *
 * Never throws: a broken `package.json` is the repo's problem, and must not
 * stop `fest claude` from starting. It just contributes no tags.
 */
export async function readRepoTags(root: string): Promise<RepoTags> {
  const files: string[] = [];
  const tags: Record<string, string> = {};
  for (const [file, pick] of [
    [PACKAGE_JSON, (o: Record<string, unknown>) => o["fest"]],
    [FEST_JSON, (o: Record<string, unknown>) => o],
  ] as const) {
    let obj: Record<string, unknown> | null;
    try {
      obj = await readJsonObject(join(root, file));
    } catch {
      continue;
    }
    if (obj === null) continue;
    const layer = readLayer(pick(obj));
    if (Object.keys(layer).length === 0) continue;
    files.push(file);
    Object.assign(tags, layer);
  }
  return { dir: root, files, tags };
}

/**
 * Write a repo's committed tags where {@link readRepoTags} finds them: an
 * existing `.fest.json` if there is one (somebody chose it), else the `fest`
 * key of a root `package.json`, else a new `.fest.json`. The rest of
 * `package.json` is left as it was, down to its indentation, and an emptied
 * layer removes the key or the file rather than leaving `{}` behind.
 *
 * `update` gets that file's own layer and returns the new one. Returns the
 * file written and what went in it. Unlike reading, a file that does not parse
 * is an error here — rewriting it would destroy it.
 */
export async function writeRepoTags(
  root: string,
  update: (current: Record<string, string>) => Record<string, string>,
): Promise<{ file: string; layer: Record<string, string> }> {
  const festPath = join(root, FEST_JSON);
  const pkgPath = join(root, PACKAGE_JSON);
  const fest = await readJsonObject(festPath);
  if (fest === null) {
    let pkgRaw: string | null = null;
    try {
      pkgRaw = await readFile(pkgPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (pkgRaw !== null) {
      const pkg = (await readJsonObject(pkgPath))!;
      const layer = update(readLayer(pkg["fest"]));
      if (Object.keys(layer).length === 0) delete pkg["fest"];
      else pkg["fest"] = layer;
      const indent = /^([ \t]+)\S/m.exec(pkgRaw)?.[1] ?? 2;
      const eol = pkgRaw.endsWith("\n") ? "\n" : "";
      await writeFile(pkgPath, JSON.stringify(pkg, null, indent) + eol);
      return { file: PACKAGE_JSON, layer };
    }
  }
  const layer = update(readLayer(fest));
  await writeLayerFile(festPath, layer);
  return { file: FEST_JSON, layer };
}

async function writeLayerFile(path: string, layer: Readonly<Record<string, string>>): Promise<void> {
  if (Object.keys(layer).length === 0) await rm(path, { force: true });
  else await writeFile(path, JSON.stringify(layer, null, 2) + "\n");
}

/** Everything a client command needs: the tags, already resolved. */
export async function sessionTags(
  flags: readonly string[],
  cwd: string = process.cwd(),
): Promise<Record<string, string>> {
  const root = gitRoot(cwd);
  return resolveTags({
    repo: root === null ? null : repoTagValue(basename(root)),
    saved: await readSavedTags(),
    repoFile: root === null ? null : await readRepoTags(root),
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
 * `fest tags`                          the layers that apply here, and the result
 * `fest tags set [-g] k=v [k=v …]`     save in this repo (or directory, or globally)
 * `fest tags unset [-g] k [k …]`       remove from the same place
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
  const root = gitRoot(cwd);

  let edit: ((current: Record<string, string>) => Record<string, string>) | null = null;
  if (sub === "set") {
    if (rest.length === 0) throw new Error("usage: fest tags set [-g] key=value [key=value …]");
    const pairs = rest.flatMap((arg) => {
      const parsed = parseTagPairs(arg);
      if (parsed.length === 0) throw new Error(`${arg}: expected key=value`);
      return parsed;
    });
    // An empty value is kept: here it means "not in this repo / directory".
    edit = (current) => Object.assign({ ...current }, ...pairs.map((p) => ({ [p.key]: p.value })));
  } else if (sub === "unset") {
    if (rest.length === 0) throw new Error("usage: fest tags unset [-g] key [key …]");
    edit = (current) => {
      const next = { ...current };
      for (const key of rest) delete next[key.toLowerCase()];
      return next;
    };
  } else if (sub !== undefined) {
    throw new Error(`unknown \`fest tags ${sub}\`. Try \`fest tags set key=value\`.`);
  }

  if (edit !== null) {
    if (global) {
      const layer = edit({ ...saved.global });
      await writeSavedTags({ global: layer, paths: saved.paths });
      out(`saved globally: ${showLayer(layer)}`);
    } else if (root !== null) {
      // In a repo the tags go IN the repo, so every clone gets them.
      const { file, layer } = await writeRepoTags(root, edit);
      out(`saved in ${join(showDir(root), file)}: ${showLayer(layer)}`);
      out(`commit ${file} so everyone working in this repo gets the same tags.`);
    } else {
      const layer = edit({ ...(saved.paths[cwd] ?? {}) });
      const paths = { ...saved.paths };
      if (Object.keys(layer).length === 0) delete paths[cwd];
      else paths[cwd] = layer;
      await writeSavedTags({ global: saved.global, paths });
      out(`saved for ${showDir(cwd)}: ${showLayer(layer)}`);
    }
    return;
  }

  const repoFile = root === null ? null : await readRepoTags(root);
  out(`global:    ${showLayer(saved.global)}`);
  for (const { dir, files, layer } of dirLayers(saved, repoFile, cwd)) {
    const label = files === null ? showDir(dir) : files.map((f) => join(showDir(dir), f)).join(" + ");
    out(`${label}:  ${showLayer(layer)}`);
  }
  const effective = await sessionTags([], cwd);
  out(`effective: ${decodeURIComponent(formatTags(effective)) || "(none)"}`);
  out("");
  out("`fest tags set` saves in this repo (package.json's \"fest\" key, else .fest.json) or,");
  out("outside a repo, for this directory and below; -g saves globally. The narrowest wins.");
  out("Effective also adds project=<git repo name> and FEST_TAGS. Override per session with");
  out("--tag key=value; an empty value (project=) removes a key.");
}
