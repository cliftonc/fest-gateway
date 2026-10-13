/**
 * `fest copilot`: run the real `copilot` binary (GitHub Copilot CLI) through
 * Fest.
 *
 * Four modes:
 *
 *  - **subscription** (default): Copilot on its own login, the developer's
 *    Copilot plan paying. `COPILOT_API_URL` — the override for the host
 *    Copilot's `copilot_internal/user` names — points at Fest's `/copilot/<plan>`
 *    mount, which relays to that same GitHub host and meters the turn. The
 *    GitHub token Copilot sends is forwarded, never stored; see
 *    `server/pipeline/copilot.ts` and `docs/COPILOT.md`.
 *  - **anthropic**: bring-your-own-key (`COPILOT_PROVIDER_*`), Copilot speaking
 *    the Anthropic Messages API to Fest's `/v1/messages` on the developer's own
 *    `ANTHROPIC_API_KEY` — the same relay Claude Code's key posture uses.
 *  - **gw**: BYOK with no key of the developer's; the Fest token goes in the
 *    bearer position, so the server's routing table supplies the credential,
 *    exactly as `fest claude gw` does.
 *  - **openai**: BYOK on the Responses API to Fest's `/openai/v1` mount on the
 *    developer's own `OPENAI_API_KEY`.
 *
 * In the BYOK modes the identity token rides in `COPILOT_PROVIDER_HEADERS` as
 * `X-Fest-Token` (gw excepted), alongside `X-Fest-Client: copilot` so the
 * dashboard can tell this traffic from Claude Code's — both send `claude-*`
 * model ids. In subscription mode Copilot sends no custom headers, so the
 * token rides in the URL (`/t/<token>`), as it does for `fest claude`, and the
 * server recognises Copilot by its own `copilot-integration-id` header.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BASE_MODELS } from "../shared/base-models.ts";
import { readCliConfig } from "./config.ts";

export type CopilotMode = "subscription" | "anthropic" | "gw" | "openai";

/** The plans GitHub serves from their own API host; mirrors the server's mount. */
export type CopilotPlan = "individual" | "business" | "enterprise";

type Env = Record<string, string | undefined>;

/**
 * The plan in a Copilot API host, or null for a host the mount cannot relay to
 * (a GHE.com data-residency tenant, say).
 */
export function planFromApiEndpoint(url: string): CopilotPlan | null {
  const m = /^https:\/\/api\.(individual|business|enterprise)\.githubcopilot\.com\/?$/.exec(url.trim());
  return m ? (m[1] as CopilotPlan) : null;
}

/**
 * The plan of the most recently signed-in account in Copilot's own user cache.
 *
 * Copilot caches its `copilot_internal/user` response under
 * `copilotUserCache["v1:<hash>"]`, one entry per account, in a JSON file with
 * `//` comment lines at the top. Only `endpoints.api` and
 * `retrievedAt` are read; nothing in it is a credential, but nothing else in
 * it is any of Fest's business either. Returns the raw host alongside, so a
 * host the mount cannot serve can be named in the error.
 */
export function planFromUserCache(text: string): { plan: CopilotPlan | null; api: string } | null {
  let root: unknown;
  try {
    root = JSON.parse(text.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n"));
  } catch {
    return null;
  }
  const entries = (root as { copilotUserCache?: unknown } | null)?.copilotUserCache;
  if (typeof entries !== "object" || entries === null) return null;
  let best: { at: string; api: string } | null = null;
  for (const entry of Object.values(entries as Record<string, unknown>)) {
    const e = entry as { retrievedAt?: unknown; response?: { endpoints?: { api?: unknown } } } | null;
    const api = e?.response?.endpoints?.api;
    if (typeof api !== "string") continue;
    const at = typeof e?.retrievedAt === "string" ? e.retrievedAt : "";
    if (best === null || at > best.at) best = { at, api };
  }
  return best === null ? null : { plan: planFromApiEndpoint(best.api), api: best.api };
}

/** Where Copilot keeps that cache, most specific first. */
export function userCacheCandidates(env: Readonly<Env>, home: string, platform: NodeJS.Platform): string[] {
  const file = "copilot-user-cache.json";
  const out: string[] = [];
  if (env["COPILOT_CACHE_HOME"]) out.push(join(env["COPILOT_CACHE_HOME"], file));
  if (platform === "darwin") out.push(join(home, "Library", "Caches", "copilot", file));
  if (platform === "win32" && env["LOCALAPPDATA"]) out.push(join(env["LOCALAPPDATA"], "copilot", file));
  out.push(join(env["XDG_CACHE_HOME"] || join(home, ".cache"), "copilot", file));
  return out;
}

/**
 * Pure, so it is testable without spawning `copilot`. Throws with a sentence a
 * developer can act on when the mode needs a key that is not there.
 */
export function buildCopilotEnv(
  base: Readonly<Env>,
  cfg: { serverUrl: string; identityToken: string; plan?: CopilotPlan | undefined },
  mode: CopilotMode,
): Env {
  const env: Env = { ...base };
  // Start from a clean provider: an inherited COPILOT_PROVIDER_BEARER_TOKEN
  // silently takes precedence over the API key set below, and an inherited
  // base URL or type would point the session somewhere else entirely. In
  // subscription mode any provider at all would take the session off the
  // Copilot plan, and an inherited API URL off Fest.
  for (const name of Object.keys(env)) {
    if (
      name.startsWith("COPILOT_PROVIDER_") ||
      name === "COPILOT_PROVIDERS_CONFIG" ||
      name === "COPILOT_API_URL" ||
      name === "COPILOT_OFFLINE"
    ) {
      delete env[name];
    }
  }

  if (mode === "subscription") {
    if (cfg.plan === undefined) throw new Error("subscription mode needs the Copilot plan.");
    env["COPILOT_API_URL"] = `${cfg.serverUrl}/t/${cfg.identityToken}/copilot/${cfg.plan}`;
    return env;
  }

  const headers = [`X-Fest-Client: copilot`];

  if (mode === "openai") {
    const key = base["OPENAI_API_KEY"] ?? "";
    if (key === "") throw new Error("`fest copilot openai` needs OPENAI_API_KEY set.");
    if ((base["COPILOT_MODEL"] ?? "") === "") {
      throw new Error("`fest copilot openai` needs COPILOT_MODEL set (e.g. COPILOT_MODEL=gpt-5.5).");
    }
    env["COPILOT_PROVIDER_TYPE"] = "openai";
    env["COPILOT_PROVIDER_WIRE_API"] = "responses";
    env["COPILOT_PROVIDER_BASE_URL"] = `${cfg.serverUrl}/openai/v1`;
    env["COPILOT_PROVIDER_API_KEY"] = key;
    headers.push(`X-Fest-Token: ${cfg.identityToken}`);
  } else {
    env["COPILOT_PROVIDER_TYPE"] = "anthropic";
    env["COPILOT_PROVIDER_BASE_URL"] = cfg.serverUrl;
    if (mode === "gw") {
      env["COPILOT_PROVIDER_BEARER_TOKEN"] = cfg.identityToken;
    } else {
      const key = base["ANTHROPIC_API_KEY"] ?? "";
      if (key === "") {
        throw new Error(
          "`fest copilot` needs ANTHROPIC_API_KEY set. Without one, `fest copilot gw` uses the gateway's own routes.",
        );
      }
      // A subscription token is Claude Code's alone; Anthropic refuses it from
      // any other client, and the refusal reads like a Fest bug.
      if (key.startsWith("sk-ant-oat")) {
        throw new Error("ANTHROPIC_API_KEY holds a Claude subscription token, which only Claude Code can use. Set an API key.");
      }
      env["COPILOT_PROVIDER_API_KEY"] = key;
      headers.push(`X-Fest-Token: ${cfg.identityToken}`);
    }
    // BYOK has no default model, and Copilot's own default is a GitHub-hosted
    // id the gateway cannot serve. Sonnet is the everyday Claude Code model.
    if ((base["COPILOT_MODEL"] ?? "") === "") {
      env["COPILOT_MODEL"] = (BASE_MODELS.find((m) => m.id.includes("sonnet")) ?? BASE_MODELS[0]!).id;
    }
  }

  env["COPILOT_PROVIDER_HEADERS"] = headers.join("\n");
  return env;
}

/**
 * Copilot's arguments under Fest.
 *
 * Copilot sends its built-in GitHub MCP server's calls to the API URL's
 * ORIGIN (`<origin>/mcp/readonly`), and Fest relays them from its root. A
 * gateway mounted under a path does not own its origin's root, so those calls
 * would land on whatever does; switching the server off is the honest option.
 */
export function copilotArgs(serverUrl: string, mode: CopilotMode, argv: readonly string[]): string[] {
  if (mode !== "subscription") return [...argv];
  const path = new URL(serverUrl).pathname.replace(/\/+$/, "");
  return path === "" ? [...argv] : ["--disable-mcp-server", "github-mcp-server", ...argv];
}

const note = (s: string): void => void process.stderr.write(`fest copilot: ${s}\n`);

async function detectPlan(env: Readonly<Env>): Promise<CopilotPlan> {
  const forced = (env["FEST_COPILOT_PLAN"] ?? "").trim();
  if (forced !== "") {
    const plan = planFromApiEndpoint(`https://api.${forced}.githubcopilot.com`);
    if (plan === null) throw new Error("FEST_COPILOT_PLAN must be individual, business or enterprise.");
    return plan;
  }
  for (const path of userCacheCandidates(env, homedir(), process.platform)) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const found = planFromUserCache(text);
    if (found === null) continue;
    if (found.plan === null) {
      throw new Error(`your Copilot account is served from ${found.api}, which Fest cannot relay to.`);
    }
    return found.plan;
  }
  throw new Error(
    "could not tell which Copilot plan you are on. Run `copilot` once and sign in, " +
      "or set FEST_COPILOT_PLAN=individual|business|enterprise.",
  );
}

export async function runCopilot(argv: readonly string[], mode: CopilotMode = "subscription"): Promise<void> {
  const cfg = await readCliConfig();
  if (cfg === null) throw new Error("not logged in. Run `fest login` first.");

  const plan = mode === "subscription" ? await detectPlan(process.env) : undefined;
  const env = buildCopilotEnv(process.env, { ...cfg, plan }, mode);
  const args = copilotArgs(cfg.serverUrl, mode, argv);
  if (mode === "subscription") {
    note(`your Copilot ${plan} plan pays; your GitHub login is relayed to GitHub through Fest, never stored.`);
    if (args.length !== argv.length) {
      note("the built-in GitHub MCP server is off: Fest is mounted under a path, and Copilot calls that server at the origin.");
    }
  } else {
    note(
      mode === "gw"
        ? "BYOK via gateway routes — org credentials pay, not your Copilot seat."
        : `BYOK on your ${mode === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} — that key pays, not your Copilot seat.`,
    );
  }

  const child = spawn("copilot", args, { stdio: "inherit", env });
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      reject(err.code === "ENOENT" ? new Error("`copilot` was not found on PATH. Install GitHub Copilot CLI first.") : err);
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
