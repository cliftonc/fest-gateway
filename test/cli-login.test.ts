/**
 * `fest login`'s loopback server: the browser is never actually launched in
 * this test (an injected `openBrowser` stands in for it) — instead we read
 * the callback URL it would have opened and hit it ourselves, exactly as a
 * real OAuth redirect would.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeHome = mkdtempSync(join(tmpdir(), "fest-clilogin-home-"));
process.env.HOME = fakeHome;

const { runLogin } = await import("../cli/login.ts");
const { readCliConfig, CONFIG_FILE } = await import("../cli/config.ts");

test.after(() => rmSync(fakeHome, { recursive: true, force: true }));

/** `runLogin` health-checks `serverUrl` before doing anything else; stand in for a real gateway. */
function mockHealthyGateway(t: { mock: { method: (...a: any[]) => any } }, serverUrl: string): void {
  const real = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    if (url === `${serverUrl}/healthz`) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return real(input, init);
  });
}

test("captures a successful callback, writes the config, and never prints the raw token", async (t) => {
  mockHealthyGateway(t, "http://example.test");
  let capturedUrl = "";
  const done = runLogin({
    provider: "google",
    serverUrl: "http://example.test",
    openBrowser: async (url) => {
      capturedUrl = url;
    },
  });

  // The loopback server is listening by the time openBrowser is invoked.
  await waitFor(() => capturedUrl !== "");
  const callbackUrl = new URL(capturedUrl).searchParams.get("cli_redirect_uri")!;
  assert.match(callbackUrl, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);

  const writes: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    writes.push(String(chunk));
    return realWrite(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    const res = await fetch(`${callbackUrl}?token=fest_supersecret&email=ada%40corp.test`);
    assert.equal(res.status, 200);
    await done;
  } finally {
    process.stdout.write = realWrite;
  }

  assert.ok(!writes.some((w) => w.includes("fest_supersecret")), "the raw token is never echoed to stdout");

  const cfg = await readCliConfig();
  assert.equal(cfg?.email, "ada@corp.test");
  assert.equal(cfg?.identityToken, "fest_supersecret");
  assert.equal(cfg?.provider, "google");
  assert.equal(statSync(CONFIG_FILE).mode & 0o777, 0o600);
});

test("an error callback rejects runLogin and writes nothing", async (t) => {
  mockHealthyGateway(t, "http://example.test");
  let capturedUrl = "";
  const done = runLogin({
    provider: "github",
    serverUrl: "http://example.test",
    openBrowser: async (url) => {
      capturedUrl = url;
    },
  });
  // Attached immediately so Node never sees this as an unhandled rejection
  // between now and the `assert.rejects` below actually awaiting it.
  done.catch(() => {});

  await waitFor(() => capturedUrl !== "");
  const callbackUrl = new URL(capturedUrl).searchParams.get("cli_redirect_uri")!;

  await fetch(`${callbackUrl}?error=domain_not_allowed`);
  await assert.rejects(() => done, /login failed: domain_not_allowed/);
});

test("refuses a server that does not answer /healthz, before opening a browser", async (t) => {
  const real = globalThis.fetch;
  let browserOpened = false;
  t.mock.method(globalThis, "fetch", async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    // Simulates pointing `--server` at a Vite dashboard dev server instead of
    // the gateway — exactly the mistake this check exists to catch.
    if (url === "http://example.test/healthz") return new Response("Cannot GET /healthz", { status: 404 });
    return real(input, init);
  });

  await assert.rejects(
    runLogin({
      provider: "google",
      serverUrl: "http://example.test",
      openBrowser: async () => {
        browserOpened = true;
      },
    }),
    /does not look like a Fest gateway/,
  );
  assert.equal(browserOpened, false);
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}
