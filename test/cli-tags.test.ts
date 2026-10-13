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
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
