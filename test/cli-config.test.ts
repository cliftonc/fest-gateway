/**
 * `~/.fest/config.json`: permissions, round trip, and the CI env override.
 *
 * `HOME` is overridden before importing `cli/config.ts`, since `CONFIG_DIR` is
 * computed once at import time from `os.homedir()` — this test must never
 * touch the real developer's `~/.fest`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeHome = mkdtempSync(join(tmpdir(), "fest-clihome-"));
process.env.HOME = fakeHome;

const { readCliConfig, writeCliConfig, clearCliConfig, CONFIG_DIR, CONFIG_FILE } = await import("../cli/config.ts");

test.after(() => rmSync(fakeHome, { recursive: true, force: true }));

test("no file yet means not logged in", async () => {
  await clearCliConfig();
  assert.equal(await readCliConfig(), null);
});

test("write then read round-trips, with 0700/0600 permissions", async () => {
  await writeCliConfig({ serverUrl: "http://localhost:8787", identityToken: "fest_abc", email: "ada@corp.test", provider: "google" });

  const dirMode = statSync(CONFIG_DIR).mode & 0o777;
  const fileMode = statSync(CONFIG_FILE).mode & 0o777;
  assert.equal(dirMode, 0o700);
  assert.equal(fileMode, 0o600);

  const read = await readCliConfig();
  assert.deepEqual(read, {
    serverUrl: "http://localhost:8787",
    identityToken: "fest_abc",
    email: "ada@corp.test",
    provider: "google",
  });
});

test("a trailing slash on serverUrl is trimmed by the caller, not silently here", async () => {
  await writeCliConfig({ serverUrl: "http://localhost:8787/", identityToken: "t", email: "e@corp.test", provider: "github" });
  const read = await readCliConfig();
  assert.equal(read?.serverUrl, "http://localhost:8787/");
});

test("FEST_TOKEN + FEST_SERVER_URL override the file", async () => {
  await writeCliConfig({ serverUrl: "http://file-server", identityToken: "file-token", email: "file@corp.test", provider: "google" });
  process.env.FEST_TOKEN = "env-token";
  process.env.FEST_SERVER_URL = "http://env-server/";
  try {
    const read = await readCliConfig();
    assert.equal(read?.identityToken, "env-token");
    assert.equal(read?.serverUrl, "http://env-server");
    assert.equal(read?.provider, "env");
  } finally {
    delete process.env.FEST_TOKEN;
    delete process.env.FEST_SERVER_URL;
  }
});

test("clearCliConfig removes the file, and is a no-op when there is none", async () => {
  await writeCliConfig({ serverUrl: "http://localhost:8787", identityToken: "t", email: "e@corp.test", provider: "google" });
  await clearCliConfig();
  assert.equal(await readCliConfig(), null);
  await clearCliConfig();
});
