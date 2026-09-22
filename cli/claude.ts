/**
 * `fest claude`: run the real `claude` binary, pointed at this developer's
 * Fest gateway, in whichever of two postures will actually work here.
 *
 * **Subscription posture** sets `ANTHROPIC_BASE_URL` to the path-prefixed
 * identity carrier (`server/auth/posture.ts`'s `parseIdentityPath`) and sets no
 * credential, so Claude Code's own OAuth login pays. **Gateway posture** sets a
 * bare base URL plus `ANTHROPIC_AUTH_TOKEN=<fest token>`, so the server's own
 * credentials pay and the server-published `/model` menu becomes reachable.
 *
 * The two are mutually exclusive in the client: gateway model discovery needs a
 * credential in the environment, and any such credential disables subscription
 * auth. So Fest picks — OAuth login present → subscription, absent → gateway —
 * and `fest claude gw` forces gateway when a developer wants the menu anyway.
 *
 * Both postures strip every demotion var first — the same reasoning
 * `tools/canary.ts` applies to its test client, from the same
 * `shared/demotion-vars.ts` list. Gateway posture then sets its token *after*
 * that strip rather than exempting it, so an inherited `ANTHROPIC_API_KEY` can
 * never survive alongside the Fest token.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEMOTION_VARS } from "../shared/demotion-vars.ts";
import { BASE_MODELS } from "../shared/base-models.ts";
import { readCliConfig } from "./config.ts";

/** A resolved posture: what the child environment will actually be built for. */
export type Posture = "subscription" | "key";

/** What the command line asked for. `auto` is resolved by `detectPosture`. */
export type RequestedPosture = Posture | "auto";

/**
 * Pure, so it's testable without spawning a real `claude` binary.
 *
 * Defaults to subscription posture: that is what `fest claude` did before there
 * was a choice, and it remains the answer for a developer with their own login.
 */
export function buildClaudeEnv(
  base: Readonly<Record<string, string | undefined>>,
  cfg: { serverUrl: string; identityToken: string },
  posture: Posture = "subscription",
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const v of DEMOTION_VARS) delete env[v];

  if (posture === "key") {
    env["ANTHROPIC_BASE_URL"] = cfg.serverUrl;
    // Set after the strip, never by exempting it from the strip list.
    env["ANTHROPIC_AUTH_TOKEN"] = cfg.identityToken;
  } else {
    env["ANTHROPIC_BASE_URL"] = `${cfg.serverUrl}/t/${cfg.identityToken}`;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Detection — metadata and keys only, never a credential value
// ---------------------------------------------------------------------------

/** The four layers Claude Code merges settings from, most general first. */
function settingsFiles(): string[] {
  return [
    join(homedir(), ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.local.json"),
    join(process.cwd(), ".claude", "settings.json"),
    join(process.cwd(), ".claude", "settings.local.json"),
  ];
}

function readSettings(path: string): Record<string, any> | "unparseable" | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch {
    return "unparseable";
  }
}

/**
 * Is this machine on an Anthropic OAuth subscription login?
 *
 * Read exactly as `tools/canary.ts::subscriptionLogin()` reads it — account
 * metadata only. No credential lives in this function, and the reason string is
 * printed to a developer's terminal, so nothing identifying goes in it either.
 */
export function detectSubscriptionLogin(): { ok: boolean; detail: string } {
  const path = join(homedir(), ".claude.json");
  if (!existsSync(path)) return { ok: false, detail: "no Anthropic subscription login found" };
  const parsed = readSettings(path);
  if (parsed === null || parsed === "unparseable") {
    return { ok: false, detail: "~/.claude.json is unparseable" };
  }
  if (!parsed["oauthAccount"]) {
    return { ok: false, detail: "no Anthropic subscription login found" };
  }
  return { ok: true, detail: "Anthropic OAuth login found" };
}

/**
 * Settings-layer demotion triggers, by KEY only.
 *
 * `buildClaudeEnv` can strip a poisoned env var; it cannot touch these, because
 * the client reads its own settings files. In subscription posture that is the
 * silent failure this whole project exists to prevent: the developer believes
 * they are on their own plan, and the session is quietly billed to someone
 * else's key. Values are never read — `env.ANTHROPIC_API_KEY` in a settings
 * file is a live secret.
 */
export function settingsDemotionTriggers(): string[] {
  const found: string[] = [];
  for (const path of settingsFiles()) {
    const parsed = readSettings(path);
    if (parsed === null) continue;
    if (parsed === "unparseable") {
      found.push(`${path}: unparseable, cannot check it`);
      continue;
    }
    if (parsed["apiKeyHelper"]) found.push(`${path}: apiKeyHelper`);
    for (const v of DEMOTION_VARS) {
      if (parsed["env"] && v in parsed["env"]) found.push(`${path}: env.${v}`);
    }
  }
  return found;
}

/**
 * The model the session will open on, as far as the CLI can observe it.
 *
 * Precedence follows the client's own: an explicit `--model` beats
 * `ANTHROPIC_MODEL`, which beats a `model` key in the settings layers (most
 * specific layer wins). `null` means *unknown* — Claude Code's built-in default
 * or the developer's last selection, neither of which is visible from here.
 */
export function resolveIntendedModel(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--model" && i + 1 < argv.length) return argv[i + 1]!;
    if (arg.startsWith("--model=")) return arg.slice("--model=".length);
  }

  const fromEnv = env["ANTHROPIC_MODEL"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

  let fromSettings: string | null = null;
  for (const path of settingsFiles()) {
    const parsed = readSettings(path);
    if (parsed === null || parsed === "unparseable") continue;
    if (typeof parsed["model"] === "string" && parsed["model"] !== "") fromSettings = parsed["model"];
  }
  return fromSettings;
}

// ---------------------------------------------------------------------------
// Preflight — servability, not merely a non-empty menu
// ---------------------------------------------------------------------------

export interface ServableVerdict {
  readonly kind: "ok" | "warn" | "fatal";
  readonly message: string;
}

/**
 * Does the model this session will open on have a substitute route?
 *
 * "The menu is non-empty" is not the question. In gateway posture there is no
 * caller credential to fall back on, so an unrouted model 401s on the first
 * message — and against a typical routing table the menu is full while Opus and
 * Haiku are both unrouted. This turns that first-message 401 into a sentence
 * read before the session starts.
 *
 * Pure: the fetch lives in `fetchServableModels`, so the cliff logic is
 * testable without a socket.
 */
export function checkServable(menu: readonly string[], intended: string | null): ServableVerdict {
  const servable = [...menu].sort();
  const list = servable.join(", ");

  if (intended !== null) {
    if (servable.includes(intended)) return { kind: "ok", message: "" };
    return {
      kind: "fatal",
      message:
        `${intended} has no substitute route on this gateway; in gateway posture it would fail on the first message.\n` +
        `Servable: ${list}`,
    };
  }

  // Unknown: the client will open on its own default or last selection. Name
  // precisely which of Anthropic's base models would fail if it picks one.
  const missing = BASE_MODELS.filter((m) => !servable.includes(m.id));
  if (missing.length === 0) return { kind: "ok", message: "" };

  const names = missing.map((m) => m.name);
  const subject =
    names.length === 1 ? `${names[0]} is` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are`;
  const object = names.length === 1 ? "it" : names.length === 2 ? "either" : "any of them";
  return {
    kind: "warn",
    message: `${subject} not routed on this gateway; selecting ${object} will fail.\nServable: ${list}`,
  };
}

/** How long to wait for the menu. The client's own discovery timeout is 3s. */
const MENU_TIMEOUT_MS = 3_000;

export type MenuResult =
  | { readonly ok: true; readonly ids: string[] }
  | { readonly ok: false; readonly fatal: boolean; readonly message: string };

/**
 * `GET /v1/models` — served without identity resolution, so no auth header is
 * needed here.
 *
 * A 404 or an empty list is fatal: gateway posture with no substitute routes
 * cannot serve anything. A network error is only a warning — a flaky link must
 * not brick a known-good gateway.
 */
export async function fetchServableModels(serverUrl: string): Promise<MenuResult> {
  let res: Response;
  try {
    res = await fetch(`${serverUrl}/v1/models?limit=1000`, {
      signal: AbortSignal.timeout(MENU_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      fatal: false,
      message: `could not reach ${serverUrl}/v1/models (${err instanceof Error ? err.message : String(err)}) — continuing unchecked.`,
    };
  }

  if (res.status === 404) {
    return {
      ok: false,
      fatal: true,
      message:
        `${serverUrl} publishes no gateway models, so gateway posture has nothing to serve.\n` +
        "The gateway needs substitute routes — check FEST_ROUTES on the server.",
    };
  }
  if (!res.ok) {
    return { ok: false, fatal: false, message: `GET /v1/models returned ${res.status} — continuing unchecked.` };
  }

  let body: { data?: Array<{ id?: unknown }> };
  try {
    body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  } catch {
    return { ok: false, fatal: false, message: "GET /v1/models returned unparseable JSON — continuing unchecked." };
  }

  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  if (ids.length === 0) {
    return {
      ok: false,
      fatal: true,
      message:
        `${serverUrl} publishes an empty model menu, so gateway posture has nothing to serve.\n` +
        "The gateway needs substitute routes — check FEST_ROUTES on the server.",
    };
  }
  return { ok: true, ids };
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

const note = (s: string): void => void process.stderr.write(`fest claude: ${s}\n`);

/**
 * Warnings about the *chosen* posture. Collected separately from the notice
 * line because the posture is now something Fest asserts rather than something
 * the developer typed — so every consequence of that assertion is said out loud.
 */
export function postureWarnings(
  posture: Posture,
  env: Readonly<Record<string, string | undefined>>,
  triggers: readonly string[],
): string[] {
  const warnings: string[] = [];
  const discovery = env["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"];

  if (posture === "subscription") {
    for (const trigger of triggers) {
      warnings.push(`${trigger} will demote this session off your subscription. Clear it or expect org billing.`);
    }
    if (discovery !== undefined && discovery !== "") {
      warnings.push("Gateway model discovery is unavailable in subscription posture. Use `fest claude gw`.");
    }
    return warnings;
  }

  if (discovery === undefined || discovery === "") {
    warnings.push("Export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 to see gateway models in /model.");
  }
  if (env["_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL"]) {
    // An explicit override: warn, don't strip.
    warnings.push("_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL disables gateway discovery. Unset it.");
  }
  return warnings;
}

export async function runClaude(argv: readonly string[], requested: RequestedPosture = "auto"): Promise<void> {
  const cfg = await readCliConfig();
  if (cfg === null) {
    throw new Error("not logged in. Run `fest login` first.");
  }

  const login = requested === "auto" ? detectSubscriptionLogin() : null;
  const posture: Posture = requested === "auto" ? (login!.ok ? "subscription" : "key") : requested;

  // Who pays, every time — not only on `gw`. Auto-detection changes the answer
  // for a developer with no subscription login, so it must never be implicit.
  if (requested !== "auto") {
    note("gateway posture forced — org credentials pay.");
  } else if (posture === "subscription") {
    note(`subscription posture (${login!.detail}) — your own plan pays.`);
  } else {
    note(`gateway posture (${login!.detail}) — org credentials pay.`);
  }

  for (const w of postureWarnings(posture, process.env, posture === "subscription" ? settingsDemotionTriggers() : [])) {
    note(w);
  }

  if (posture === "key") {
    const menu = await fetchServableModels(cfg.serverUrl);
    if (!menu.ok) {
      if (menu.fatal) throw new Error(menu.message);
      note(menu.message);
    } else {
      const verdict = checkServable(menu.ids, resolveIntendedModel(argv, process.env));
      if (verdict.kind === "fatal") throw new Error(verdict.message);
      if (verdict.kind === "warn") note(verdict.message);
    }
  }

  const env = buildClaudeEnv(process.env, cfg, posture);

  const child = spawn("claude", argv as string[], { stdio: "inherit", env });

  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error("`claude` was not found on PATH. Install Claude Code first."));
      } else {
        reject(err);
      }
    });
    child.on("exit", (exitCode, signal) => {
      if (signal !== null) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(exitCode ?? 1);
    });
  });

  process.exitCode = code;
}
