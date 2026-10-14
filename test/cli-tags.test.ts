/**
 * The CLI's half of request tags: which tags a session sends, and that every
 * base URL it builds round-trips through the server's own parser. The second
 * part is the one that matters — a tag segment in the wrong place does not
 * fail loudly, it 404s every request from that client.
 *
 * `HOME` is overridden before importing, as in `cli-config.test.ts`, so
 * `fest tags set` never touches the real developer's `~/.fest`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeHome = mkdtempSync(join(tmpdir(), "fest-tagshome-"));
process.env.HOME = fakeHome;

const {
  peelTagFlags,
  resolveTags,
  repoTagValue,
  gitRepoName,
  readSavedTags,
  runTags,
  sessionTags,
  canonicalDir,
  readRepoTags,
  TAGS_FILE,
} = await import("../cli/tags.ts");
const { buildClaudeEnv } = await import("../cli/claude.ts");
const { buildCodexInvocation } = await import("../cli/codex.ts");
const { buildCopilotEnv } = await import("../cli/copilot.ts");
const { parseIdentityPath } = await import("../server/auth/posture.ts");

test.after(() => rmSync(fakeHome, { recursive: true, force: true }));

const SERVER = "https://fest.example.com";
const TOKEN = "fest_abc123";
const TAGS = { team: "Platform team", project: "fest" };

/** What the server makes of a URL the CLI built, relative to the server root. */
function serverSees(url: string): ReturnType<typeof parseIdentityPath> {
  assert.ok(url.startsWith(SERVER), url);
  return parseIdentityPath(url.slice(SERVER.length));
}

test("only leading --tag flags are Fest's; everything after belongs to the child", () => {
  assert.deepEqual(peelTagFlags(["--tag", "a=1", "--tag=b=2", "--resume", "--tag", "c=3"]), {
    tags: ["a=1", "b=2"],
    rest: ["--resume", "--tag", "c=3"],
  });
  assert.deepEqual(peelTagFlags(["--", "--tag", "a=1"]), { tags: [], rest: ["--", "--tag", "a=1"] });
  assert.throws(() => peelTagFlags(["--tag"]), /needs a value/);
});

test("precedence: repo < global < outer dir < inner dir < FEST_TAGS < --tag", () => {
  const saved = {
    global: { team: "platform", env: "dev" },
    paths: {
      "/w": { team: "data" },
      "/w/fest": { project: "festival" },
      "/w/fest-other": { project: "wrong" },
      "/elsewhere": { team: "wrong" },
    },
  };
  const layers = { repo: "fest", saved, cwd: "/w/fest/sub", env: "env=ci", flags: [] };
  assert.deepEqual(resolveTags(layers), { project: "festival", team: "data", env: "ci" });
  assert.equal(resolveTags({ ...layers, cwd: "/w" }).project, "fest", "a sibling prefix is not an ancestor");
  assert.equal(resolveTags({ ...layers, cwd: "/tmp" }).team, "platform");
  assert.equal(resolveTags({ ...layers, flags: ["project=spike"] }).project, "spike");
  assert.equal(resolveTags({ ...layers, flags: ["project="] }).project, undefined);
  // A directory can remove what an outer layer set.
  const removed = { ...saved, paths: { ...saved.paths, "/w/fest": { team: "" } } };
  assert.equal(resolveTags({ ...layers, saved: removed }).team, undefined);
  assert.throws(() => resolveTags({ ...layers, flags: ["nonsense"] }), /expected key=value/);
});

test("a repo name becomes a valid tag value", () => {
  assert.equal(repoTagValue("fest"), "fest");
  assert.equal(repoTagValue("my/odd+repo"), "my-odd-repo");
  assert.equal(repoTagValue(""), null);
  assert.equal(gitRepoName(tmpdir()), null, "outside a repo there is no default");
});

test("Claude Code: both postures carry the tags and still parse as the same request", () => {
  const sub = buildClaudeEnv({}, { serverUrl: SERVER, identityToken: TOKEN, tags: TAGS }, "subscription");
  const seen = serverSees(`${sub["ANTHROPIC_BASE_URL"]}/v1/messages?beta=true`);
  assert.equal(seen.token, TOKEN);
  assert.equal(seen.remainder, "/v1/messages?beta=true");
  assert.deepEqual(seen.tags, TAGS);

  const key = buildClaudeEnv({}, { serverUrl: SERVER, identityToken: TOKEN, tags: TAGS }, "key");
  const keySeen = serverSees(`${key["ANTHROPIC_BASE_URL"]}/v1/messages`);
  assert.equal(keySeen.token, null);
  assert.equal(keySeen.remainder, "/v1/messages");
  assert.deepEqual(keySeen.tags, TAGS);

  // No tags, no segment: the URL is exactly what it was before tags existed.
  assert.equal(buildClaudeEnv({}, { serverUrl: SERVER, identityToken: TOKEN })["ANTHROPIC_BASE_URL"], `${SERVER}/t/${TOKEN}`);
});

test("Codex: the tag segment sits in front of the mount in both modes", () => {
  for (const [mode, mount] of [["chatgpt", "/chatgpt/backend-api/codex"], ["key", "/openai/v1"]] as const) {
    const { args } = buildCodexInvocation({}, { serverUrl: SERVER, identityToken: TOKEN, tags: TAGS }, mode);
    const baseArg = args.find((a) => a.startsWith("model_providers.fest.base_url="));
    const url = JSON.parse(baseArg!.slice("model_providers.fest.base_url=".length)) as string;
    const seen = serverSees(`${url}/responses`);
    assert.equal(seen.remainder, `${mount}/responses`);
    assert.deepEqual(seen.tags, TAGS);
  }
});

test("Copilot: on its own login and in every BYOK mode", () => {
  const cfg = { serverUrl: SERVER, identityToken: TOKEN, tags: TAGS, plan: "individual" as const };
  const sub = serverSees(`${buildCopilotEnv({}, cfg, "subscription")["COPILOT_API_URL"]}/responses`);
  assert.equal(sub.token, TOKEN);
  assert.equal(sub.remainder, "/copilot/individual/responses");
  assert.deepEqual(sub.tags, TAGS);

  const gw = serverSees(`${buildCopilotEnv({}, cfg, "gw")["COPILOT_PROVIDER_BASE_URL"]}/v1/messages`);
  assert.equal(gw.remainder, "/v1/messages");
  assert.deepEqual(gw.tags, TAGS);

  const openai = buildCopilotEnv({ OPENAI_API_KEY: "sk-x", COPILOT_MODEL: "gpt-5.5" }, cfg, "openai");
  const oa = serverSees(`${openai["COPILOT_PROVIDER_BASE_URL"]}/responses`);
  assert.equal(oa.remainder, "/openai/v1/responses");
  assert.deepEqual(oa.tags, TAGS);
});

test("fest tags saves for the current directory unless -g", async () => {
  const lines: string[] = [];
  const out = (s: string): void => void lines.push(s);
  const work = canonicalDir(mkdtempSync(join(fakeHome, "work-")));
  const repo = join(work, "fest");
  mkdirSync(repo);
  const opts = { out, cwd: repo };

  await runTags(["set", "-g", "team=platform"], opts);
  await runTags(["set", "team=data"], { out, cwd: work });
  await runTags(["set", "project=festival", "env=dev"], opts);
  const saved = await readSavedTags();
  assert.deepEqual(saved.global, { team: "platform" });
  assert.deepEqual(saved.paths[work], { team: "data" });
  assert.deepEqual(saved.paths[repo], { project: "festival", env: "dev" });
  assert.equal(statSync(TAGS_FILE).mode & 0o777, 0o600);

  assert.deepEqual(await sessionTags([], repo), { team: "data", project: "festival", env: "dev" });
  assert.deepEqual(await sessionTags([], fakeHome), { team: "platform" });

  await runTags(["unset", "env", "project"], opts);
  assert.equal((await readSavedTags()).paths[repo], undefined, "an emptied directory is dropped");
  await runTags(["unset", "--global", "team"], opts);
  assert.deepEqual((await readSavedTags()).global, {});

  lines.length = 0;
  await runTags([], opts);
  assert.ok(lines.some((l) => l.includes("team=data")), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("effective:")), lines.join("\n"));
  await assert.rejects(runTags(["set", "nonsense"], opts), /expected key=value/);
  await assert.rejects(runTags(["frobnicate"], opts), /unknown/);
});

test("the original flat tags.json reads as global tags", async () => {
  writeFileSync(TAGS_FILE, JSON.stringify({ team: "legacy" }));
  assert.deepEqual(await readSavedTags(), { global: { team: "legacy" }, paths: {} });
});

/** A fresh git repo under the fake home, so `fest tags set` sees a root. */
function makeRepo(name: string): string {
  const dir = canonicalDir(mkdtempSync(join(fakeHome, `${name}-`)));
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

test("in a repo with a package.json, tags go in its fest key and keep its formatting", async () => {
  const lines: string[] = [];
  const out = (s: string): void => void lines.push(s);
  const repo = makeRepo("node-app");
  const sub = join(repo, "src");
  mkdirSync(sub);
  writeFileSync(join(repo, "package.json"), '{\n\t"name": "app",\n\t"version": "1.0.0"\n}\n');

  await runTags(["set", "team=platform", "project=blah"], { out, cwd: sub });
  const raw = readFileSync(join(repo, "package.json"), "utf8");
  assert.equal(raw, '{\n\t"name": "app",\n\t"version": "1.0.0",\n\t"fest": {\n\t\t"team": "platform",\n\t\t"project": "blah"\n\t}\n}\n');
  assert.ok(!existsSync(join(repo, ".fest.json")));
  assert.ok(lines.some((l) => l.includes("commit package.json")), lines.join("\n"));
  assert.equal((await readSavedTags()).paths[sub], undefined, "nothing saved in ~/.fest for a repo");

  assert.deepEqual(await sessionTags([], sub), { project: "blah", team: "platform" });

  await runTags(["unset", "team", "project"], { out, cwd: repo });
  assert.equal(readFileSync(join(repo, "package.json"), "utf8"), '{\n\t"name": "app",\n\t"version": "1.0.0"\n}\n', "an emptied layer removes the key");
});

test("in a repo without a package.json, tags go in .fest.json at the root", async () => {
  const repo = makeRepo("go-app");
  const opts = { out: () => {}, cwd: repo };
  await runTags(["set", "team=data"], opts);
  assert.deepEqual(JSON.parse(readFileSync(join(repo, ".fest.json"), "utf8")), { team: "data" });
  assert.equal((await sessionTags([], repo)).team, "data");
  // Once a .fest.json exists it stays the place, even if a package.json appears.
  writeFileSync(join(repo, "package.json"), "{}\n");
  await runTags(["set", "env=dev"], opts);
  assert.deepEqual(JSON.parse(readFileSync(join(repo, ".fest.json"), "utf8")), { team: "data", env: "dev" });
  assert.equal(readFileSync(join(repo, "package.json"), "utf8"), "{}\n");
  await runTags(["unset", "team", "env"], opts);
  assert.ok(!existsSync(join(repo, ".fest.json")), "an emptied .fest.json is removed");
});

test("the narrowest layer wins: global < repo file < a saved directory inside the repo", async () => {
  const repo = makeRepo("layered");
  const inner = join(repo, "packages", "web");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", fest: { team: "repo-team", project: "mono" } }));
  writeFileSync(TAGS_FILE, JSON.stringify({ global: { team: "global-team", env: "g" }, paths: { [repo]: { team: "personal" }, [inner]: { project: "web" } } }));

  assert.deepEqual(await sessionTags([], repo), { team: "repo-team", env: "g", project: "mono" }, "the committed file wins a tie");
  assert.deepEqual(await sessionTags([], inner), { team: "repo-team", env: "g", project: "web" });
  writeFileSync(TAGS_FILE, "{}");
});

test("a broken package.json contributes no tags but is never rewritten", async () => {
  const repo = makeRepo("broken");
  writeFileSync(join(repo, "package.json"), "{ not json");
  assert.deepEqual((await readRepoTags(repo)).tags, {});
  assert.match((await sessionTags([], repo)).project ?? "", /^broken-/, "the repo-name default still applies");
  await assert.rejects(runTags(["set", "team=x"], { out: () => {}, cwd: repo }), SyntaxError);
  assert.equal(readFileSync(join(repo, "package.json"), "utf8"), "{ not json");
});
