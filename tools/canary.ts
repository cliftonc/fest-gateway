/**
 * Fest version canary — the highest-value test in the plan.
 *
 * Subscription pass-through works because no guard exists in Claude Code's
 * inference client, not because it is a supported feature. An upstream refactor
 * could add a host check, or Anthropic could start rejecting a relayed bearer,
 * and *neither would announce itself*. The failure mode is silent: every
 * developer demoted off their own subscription onto whatever key the server
 * holds, with the bill landing in one place and the dashboard still green.
 *
 * So: before rolling a new Claude Code release to the team, re-run Phase 0's two
 * load-bearing experiments against it.
 *
 *   (a) Does the subscription bearer still arrive at a custom base URL?
 *   (e) Does Anthropic still accept that bearer when Fest relays it?
 *
 * This drives the real `claude` binary against the real Phase 0 capture server —
 * the same code path Phase 0 validated — rather than re-implementing the checks,
 * because a canary that tests a reimplementation tests nothing.
 *
 * Usage:
 *   npm run canary               # both runs; (e) sends one real prompt upstream
 *   npm run canary -- --observe-only     # run (a) only; no upstream traffic
 *   npm run canary -- --json             # machine-readable verdict on stdout
 *
 * Exit codes:
 *   0  PASS         — safe to roll this release to the team
 *   1  FAIL         — a gate broke. Do not roll out. Read the checks.
 *   2  INCONCLUSIVE — could not run (no binary, not a subscription login, or a
 *                     demotion trigger in the environment). Nothing was proven.
 *
 * Requires a real Max/Team login on this machine. It is a pre-rollout gate run
 * by a person or a laptop cron, not a CI job: CI has no subscription to relay.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Test seams. Overridden only by test/canary.test.ts; unset in real use. */
const CLAUDE_BIN = process.env.CANARY_CLAUDE_BIN ?? "claude";
const UPSTREAM = process.env.CANARY_UPSTREAM ?? "https://api.anthropic.com";
const HISTORY = process.env.CANARY_HISTORY ?? join(ROOT, "docs", "canary-history.jsonl");
const LOG_DIR = process.env.CANARY_LOG_DIR ?? join(ROOT, "data", "canary");
const PRECHECK = process.env.CANARY_SKIP_PRECHECK !== "1";
/**
 * The model is pinned rather than inherited. A developer's settings may select a
 * model that only exists behind Fest's routing table (`claude-deepseek-v4`, say),
 * and run (e) would then get a 404 from Anthropic and read as a broken release.
 * An alias, not a dated id, so the installed release resolves it its own way.
 */
const MODEL = process.env.CANARY_MODEL ?? "haiku";

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const OBSERVE_ONLY = args.includes("--observe-only");
const TIMEOUT_MS = Number(process.env.CANARY_TIMEOUT_MS ?? 180_000);

type Status = "pass" | "fail" | "skip";

interface Check {
  readonly id: string;
  readonly status: Status;
  /** What was being asked, in the words of the person reading a red result. */
  readonly what: string;
  readonly detail: string;
}

const checks: Check[] = [];
function check(id: string, status: Status, what: string, detail: string): void {
  checks.push({ id, status, what, detail });
}

/** Ask the OS for a free port rather than guessing one; two canaries may overlap. */
async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

class Inconclusive extends Error {}

// ---------------------------------------------------------------------------
// Preflight. Every one of these would invalidate a run by demoting the client
// off its subscription — a red result caused by local config, misread as a
// broken release, is worse than no canary at all.
// ---------------------------------------------------------------------------

const DEMOTION_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

function settingsFiles(): string[] {
  return [
    join(homedir(), ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.local.json"),
    join(process.cwd(), ".claude", "settings.json"),
    join(process.cwd(), ".claude", "settings.local.json"),
  ];
}

/**
 * Settings layers are searched for demotion triggers by KEY only. Values are
 * never read into the report: `env.ANTHROPIC_API_KEY` in a settings file is a
 * live secret.
 */
function settingsTriggers(): string[] {
  const found: string[] = [];
  for (const path of settingsFiles()) {
    if (!existsSync(path)) continue;
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      found.push(`${path}: unparseable, cannot clear it`);
      continue;
    }
    if (parsed.apiKeyHelper) found.push(`${path}: apiKeyHelper`);
    for (const v of DEMOTION_VARS) {
      if (parsed.env && v in parsed.env) found.push(`${path}: env.${v}`);
    }
  }
  return found;
}

/**
 * Confirm this machine is on an OAuth subscription login. Without it, run (a)
 * reporting ANTHROPIC_API_KEY is ambiguous: it looks identical to the
 * regression the canary exists to catch. Only account metadata is read — no
 * credential lives in this file, and nothing identifying is reported.
 */
function subscriptionLogin(): { ok: boolean; detail: string } {
  const path = join(homedir(), ".claude.json");
  if (!existsSync(path)) return { ok: false, detail: "~/.claude.json absent — is Claude Code logged in?" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const account = parsed.oauthAccount;
    if (!account) return { ok: false, detail: "no oauthAccount in ~/.claude.json — this looks like an API-key login" };
    const tier = account.seatTier ?? account.billingType ?? "unknown";
    return { ok: true, detail: `OAuth login present, seat tier ${JSON.stringify(tier)}` };
  } catch {
    return { ok: false, detail: "~/.claude.json unparseable" };
  }
}

async function claudeVersion(): Promise<string> {
  const proc = spawn(CLAUDE_BIN, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => (out += String(d)));
  const [code] = (await once(proc, "close").catch(() => [null])) as [number | null];
  if (code !== 0) throw new Inconclusive(`\`${CLAUDE_BIN} --version\` did not run — is Claude Code installed?`);
  // "2.1.278 (Claude Code)" -> "2.1.278"
  return (/^[\d.]+/.exec(out.trim())?.[0] ?? out.trim()) || "unknown";
}

function preflight(): void {
  if (!PRECHECK) {
    check("preflight", "skip", "environment is clean of demotion triggers", "skipped via CANARY_SKIP_PRECHECK");
    return;
  }

  const envHits = DEMOTION_VARS.filter((v) => process.env[v]);
  const fileHits = settingsTriggers();
  const login = subscriptionLogin();

  // ANTHROPIC_BASE_URL in the ambient env is not a demotion trigger, but the
  // canary sets its own; an inherited one would silently point the run at the
  // wrong server. Both are cleared for the child either way — they are reported
  // so a person knows their shell is not what they think it is.
  if (envHits.length > 0) {
    check("preflight.env", "pass", "no demotion triggers inherited from the shell", `cleared for the child: ${envHits.join(", ")}`);
  } else {
    check("preflight.env", "pass", "no demotion triggers inherited from the shell", "none set");
  }

  if (fileHits.length > 0) {
    // Settings files cannot be cleared with `env -u`; the client reads them itself.
    throw new Inconclusive(
      `settings layers would demote this run off the subscription:\n  ${fileHits.join("\n  ")}\nClear these and re-run.`,
    );
  }
  check("preflight.settings", "pass", "no apiKeyHelper or key vars in any settings layer", `${settingsFiles().length} layers checked`);

  if (!login.ok) throw new Inconclusive(login.detail);
  check("preflight.login", "pass", "this machine is on a subscription login", login.detail);
}

// ---------------------------------------------------------------------------
// Running one experiment: capture server up, one `claude -p`, read the log.
// ---------------------------------------------------------------------------

interface CaptureRecord {
  readonly url?: string;
  readonly outcome?: string;
  readonly credentialKinds?: string[];
  readonly anthropic_beta?: string;
  readonly upstream?: { status?: number; errorEventSeen?: string | null; requestId?: string | null };
  readonly [k: string]: unknown;
}

async function waitForListening(proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  let buffered = "";
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      once(proc.stderr!, "data").then(([d]) => String(d)),
      new Promise<string>((r) => setTimeout(() => r(""), 200)),
    ]);
    buffered += chunk;
    if (buffered.includes("capture-server:")) return;
    if (proc.exitCode !== null) break;
  }
  throw new Inconclusive(`capture server did not start. stderr:\n${buffered}`);
}

/**
 * One experiment. Spawns the Phase 0 capture server on a free port, points one
 * `claude -p` at it, and returns everything the server recorded.
 *
 * The prompt is deliberately trivial: in forward mode this is real spend on the
 * developer's own subscription, and the canary should cost a handful of tokens.
 */
async function experiment(mode: "observe" | "forward", prompt: string, logPath: string): Promise<CaptureRecord[]> {
  const port = await freePort();

  const server = spawn(process.execPath, [join(ROOT, "tools", "capture-server.ts")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MODE: mode, LOG: logPath, UPSTREAM },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverStderr = "";
  server.stderr!.on("data", (d) => (serverStderr += String(d)));

  try {
    await waitForListening(server);

    // Build the client environment by subtraction, exactly as PHASE0.md's
    // `env -u` invocations do: whatever is in the operator's shell must not
    // change what this measures.
    const childEnv = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` };
    for (const v of DEMOTION_VARS) {
      if (v !== "ANTHROPIC_BASE_URL") delete (childEnv as Record<string, string | undefined>)[v];
    }

    const client = spawn(CLAUDE_BIN, ["-p", prompt, "--model", MODEL], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let clientOut = "";
    client.stdout.on("data", (d) => (clientOut += String(d)));
    client.stderr.on("data", (d) => (clientOut += String(d)));

    const timer = setTimeout(() => client.kill("SIGKILL"), TIMEOUT_MS);
    // Run (a) ends in a 400 by design, so the client's exit code is not the
    // signal here — the capture log is. Both runs are judged only on what the
    // server saw.
    await once(client, "close").catch(() => {});
    clearTimeout(timer);

    // The server appends synchronously per request, but the last response may
    // still be draining when the client exits.
    await new Promise((r) => setTimeout(r, 250));

    if (!existsSync(logPath)) {
      throw new Inconclusive(`no requests reached the capture server. client said:\n${clientOut.slice(0, 600)}`);
    }
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as CaptureRecord);
  } finally {
    server.kill("SIGKILL");
    if (serverStderr.includes("EADDRINUSE")) throw new Inconclusive("capture server port was taken");
  }
}

const isMessages = (r: CaptureRecord): boolean => /\/v1\/messages(\?|$)/.test(r.url ?? "");

async function runA(logPath: string): Promise<void> {
  const records = (await experiment("observe", "hi", logPath)).filter(isMessages);

  if (records.length === 0) {
    check("a.reached", "fail", "Claude Code sent an inference request to the custom base URL", "no /v1/messages request was recorded at all");
    return;
  }
  check("a.reached", "pass", "Claude Code sent an inference request to the custom base URL", `${records.length} recorded`);

  const kinds = new Set(records.flatMap((r) => r.credentialKinds ?? []));

  // The headline. If this flips to ANTHROPIC_API_KEY, every developer on this
  // release is about to be billed to whatever key the gateway holds.
  if (kinds.has("ANTHROPIC_OAUTH_SUBSCRIPTION")) {
    check("a.bearer", "pass", "the subscription OAuth bearer still reaches a custom base URL", "ANTHROPIC_OAUTH_SUBSCRIPTION present");
  } else {
    check("a.bearer", "fail", "the subscription OAuth bearer still reaches a custom base URL", `credential kinds seen: ${[...kinds].join(", ") || "none"}`);
  }

  if (kinds.has("ANTHROPIC_API_KEY")) {
    check("a.nokey", "fail", "no API key was substituted for the subscription", "an ANTHROPIC_API_KEY arrived — the client demoted despite a clean environment");
  } else {
    check("a.nokey", "pass", "no API key was substituted for the subscription", "none seen");
  }

  const betas = records.map((r) => r.anthropic_beta ?? "").join(" ");
  if (betas.includes("oauth-2025-04-20")) {
    check("a.beta", "pass", "the oauth beta flag still rides with the bearer", "oauth-2025-04-20 present");
  } else {
    // Not fatal on its own — (e) is the real arbiter — but it is the flag
    // Anthropic keys acceptance off, so a change here explains a red (e).
    check("a.beta", "fail", "the oauth beta flag still rides with the bearer", `anthropic-beta was: ${betas.slice(0, 200) || "absent"}`);
  }
}

async function runE(logPath: string): Promise<void> {
  const records = (await experiment("forward", "say hello in five words", logPath)).filter(
    (r) => isMessages(r) && r.outcome !== "probe_ok",
  );

  const forwarded = records.filter((r) => r.outcome === "forwarded");
  if (forwarded.length === 0) {
    const failed = records.find((r) => r.outcome === "forward_failed");
    check("e.forwarded", "fail", "Fest could relay the request to Anthropic", failed ? String(failed.error).slice(0, 200) : "nothing was forwarded");
    return;
  }

  // A model the account cannot reach is not an auth answer. Separating this from
  // FAIL is the difference between a canary people act on and one they learn to
  // ignore: the first false red teaches the team to dismiss the next real one.
  const notFound = forwarded.find(
    (r) => r.upstream?.status === 404 && /not_found_error/.test(String(r.upstream?.errorEventSeen ?? "")),
  );
  if (notFound) {
    throw new Inconclusive(
      `Anthropic returned 404 for model "${MODEL}" — the bearer was read, the model was not found.\n` +
        `This says nothing about pass-through. Set CANARY_MODEL to a model this account can reach.`,
    );
  }

  // "Anthropic accepted a relayed subscription bearer" is the whole product.
  const ok = forwarded.find((r) => r.upstream?.status === 200);
  if (ok) {
    check("e.accepted", "pass", "Anthropic still accepts a relayed subscription bearer", `HTTP 200, request-id ${ok.upstream?.requestId ?? "-"}`);
  } else {
    const statuses = forwarded.map((r) => r.upstream?.status).join(", ");
    check("e.accepted", "fail", "Anthropic still accepts a relayed subscription bearer", `upstream statuses: ${statuses}. A 401/403 means acceptance now checks more than the bearer.`);
  }

  // A 200 whose stream carries an error event is a rejection in disguise.
  const errored = forwarded.find((r) => r.upstream?.errorEventSeen);
  if (errored) {
    check("e.stream", "fail", "the relayed response streamed without an error event", String(errored.upstream?.errorEventSeen).slice(0, 200));
  } else {
    check("e.stream", "pass", "the relayed response streamed without an error event", "clean stream");
  }
}

// ---------------------------------------------------------------------------
// Verdict and history
// ---------------------------------------------------------------------------

function lastRecorded(): { version: string; verdict: string; at: string } | null {
  if (!existsSync(HISTORY)) return null;
  const lines = readFileSync(HISTORY, "utf8").split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]!);
    } catch {
      /* a half-written line should not break the report */
    }
  }
  return null;
}

function writeHistory(entry: Record<string, unknown>): void {
  mkdirSync(dirname(HISTORY), { recursive: true });
  appendFileSync(HISTORY, JSON.stringify(entry) + "\n");
}

async function main(): Promise<number> {
  let version = "unknown";
  const startedAt = new Date().toISOString();
  const previous = lastRecorded();

  try {
    version = await claudeVersion();
    preflight();

    mkdirSync(LOG_DIR, { recursive: true });
    const stamp = startedAt.replace(/[:.]/g, "-");

    await runA(join(LOG_DIR, `${version}-${stamp}-a.jsonl`));
    if (OBSERVE_ONLY) {
      check("e.accepted", "skip", "Anthropic still accepts a relayed subscription bearer", "--observe-only: no upstream traffic");
    } else {
      await runE(join(LOG_DIR, `${version}-${stamp}-e.jsonl`));
    }
  } catch (err) {
    if (err instanceof Inconclusive) {
      const entry = { at: startedAt, version, verdict: "inconclusive", reason: err.message, checks };
      writeHistory(entry);
      report(entry, previous);
      return 2;
    }
    throw err;
  }

  const failed = checks.filter((c) => c.status === "fail");
  const skipped = checks.some((c) => c.status === "skip" && c.id.startsWith("e."));
  // An --observe-only run proves the client half only. It is deliberately not
  // a PASS: half the gate is the half that involves Anthropic.
  const verdict = failed.length > 0 ? "fail" : skipped ? "partial" : "pass";
  const entry = { at: startedAt, version, verdict, checks };
  writeHistory(entry);
  report(entry, previous);
  return verdict === "fail" ? 1 : verdict === "partial" ? 0 : 0;
}

function report(entry: Record<string, any>, previous: ReturnType<typeof lastRecorded>): void {
  if (JSON_OUT) {
    console.log(JSON.stringify(entry, null, 2));
    // The verdict still goes to stderr. A cron that pipes stdout to a file and
    // mails stderr must not be the one place the "do NOT roll out" line is lost.
    console.error(verdictBanner(entry));
    return;
  }

  const mark = { pass: "  ok  ", fail: " FAIL ", skip: " skip " };
  console.log(`\nFest version canary — Claude Code ${entry.version}, model ${MODEL}`);
  if (previous && previous.version !== entry.version) {
    console.log(`  (last recorded run was ${previous.version}, ${previous.verdict}, ${previous.at})`);
  }
  console.log("");
  for (const c of entry.checks as Check[]) {
    console.log(`[${mark[c.status]}] ${c.what}`);
    console.log(`          ${c.detail}`);
  }
  console.log("");
  console.log(verdictBanner(entry));
}

function verdictBanner(entry: Record<string, any>): string {
  if (entry.verdict === "pass") {
    return `VERDICT: PASS — ${entry.version} is safe to roll out. Recorded in ${HISTORY}.`;
  }
  if (entry.verdict === "partial") {
    return `VERDICT: PARTIAL — the client half passed. Run without --observe-only before rolling out.`;
  }
  if (entry.verdict === "inconclusive") {
    return `VERDICT: INCONCLUSIVE — nothing was proven.\n\n${entry.reason}\n`;
  }
  return (
    `VERDICT: FAIL — do NOT roll ${entry.version} out to the team.\n\n` +
    `Subscription pass-through has changed in this release. Until this is understood,\n` +
    `pin developers to the last version recorded as PASS in ${HISTORY}.\n` +
    `To localise the change, re-run the Phase 0 runs by hand from docs/PHASE0.md,\n` +
    `altering one thing at a time.`
  );
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("canary: unexpected failure\n", err);
    process.exit(2);
  },
);
