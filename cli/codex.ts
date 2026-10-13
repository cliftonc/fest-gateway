/**
 * `fest codex`: run the real `codex` binary, pointed at this developer's Fest
 * gateway, on whichever credential Codex is already logged in with.
 *
 * Codex has no base-URL environment variable any more; a gateway is a custom
 * model provider. So Fest defines one for the life of the process with `-c`
 * overrides and never edits `~/.codex/config.toml` — a developer's own config
 * stays exactly as they left it, and plain `codex` still goes direct.
 *
 * Two modes, mirroring the two server mounts (`server/pipeline/openai.ts`):
 *
 *  - **ChatGPT login** (`auth_mode: "chatgpt"` in `~/.codex/auth.json`): base
 *    URL `<fest>/chatgpt/backend-api/codex`, `requires_openai_auth = true`, so
 *    Codex sends its own ChatGPT token and the developer's plan pays.
 *  - **API key**: base URL `<fest>/openai/v1`. With `OPENAI_API_KEY` set,
 *    Codex reads it via `env_key`; otherwise `requires_openai_auth` lets it use
 *    a key stored by `codex login --with-api-key`. The key's owner pays.
 *
 * The Fest identity token travels in an `X-Fest-Token` header that Codex reads
 * from an environment variable (`env_http_headers`). It is never in argv:
 * `-c` values are visible to anyone who can run `ps`.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCliConfig } from "./config.ts";
import { describeTags, sessionTags, tagSuffix } from "./tags.ts";
import type { Tags } from "../shared/tags.ts";

export type CodexMode = "chatgpt" | "key";

/**
 * The child-only variable `env_http_headers` reads the token from. Not
 * `FEST_TOKEN`: that one means "use this instead of ~/.fest" to the fest CLI
 * itself, and a Codex shell tool running `fest` should not inherit that.
 */
export const TOKEN_ENV = "FEST_GATEWAY_TOKEN";

/** Codex's own config directory. `CODEX_HOME` moves it. */
function codexHome(env: Readonly<Record<string, string | undefined>>): string {
  const fromEnv = env["CODEX_HOME"];
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : join(homedir(), ".codex");
}

/**
 * How is Codex logged in? Reads the `auth_mode` key only — `auth.json` also
 * holds the ChatGPT tokens and any stored API key, and none of that is read.
 */
export function detectCodexMode(env: Readonly<Record<string, string | undefined>>): {
  mode: CodexMode;
  detail: string;
} {
  const path = join(codexHome(env), "auth.json");
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (parsed["auth_mode"] === "chatgpt") return { mode: "chatgpt", detail: "ChatGPT login found" };
      if (parsed["auth_mode"] === "apikey") return { mode: "key", detail: "Codex API-key login found" };
    } catch {
      // Unparseable: fall through and let Codex itself say what is wrong.
    }
  }
  return { mode: "key", detail: "no ChatGPT login found" };
}

/** TOML string literal for a `-c key=value` override. */
const toml = (s: string): string => JSON.stringify(s);

/**
 * Pure, so it is testable without spawning `codex`. Returns the args to put in
 * FRONT of the developer's own (they are top-level options, so they apply to
 * `codex`, `codex exec` and `codex resume` alike) and the child environment.
 */
export function buildCodexInvocation(
  base: Readonly<Record<string, string | undefined>>,
  cfg: { serverUrl: string; identityToken: string; tags?: Tags | undefined },
  mode: CodexMode,
): { args: string[]; env: Record<string, string | undefined> } {
  const server = `${cfg.serverUrl}${tagSuffix(cfg.tags ?? {})}`;
  const p = "model_providers.fest";
  const args = [
    "-c", `model_provider=${toml("fest")}`,
    "-c", `${p}.name=${toml("Fest")}`,
    "-c", `${p}.wire_api=${toml("responses")}`,
    "-c", `${p}.env_http_headers={ "X-Fest-Token" = ${toml(TOKEN_ENV)} }`,
    "-c", `${p}.http_headers={ "X-Fest-Client" = ${toml("codex")} }`,
  ];

  const hasEnvKey = (base["OPENAI_API_KEY"] ?? "") !== "";
  if (mode === "chatgpt") {
    args.push("-c", `${p}.base_url=${toml(`${server}/chatgpt/backend-api/codex`)}`);
    args.push("-c", `${p}.requires_openai_auth=true`);
  } else {
    args.push("-c", `${p}.base_url=${toml(`${server}/openai/v1`)}`);
    args.push(
      "-c",
      hasEnvKey ? `${p}.env_key=${toml("OPENAI_API_KEY")}` : `${p}.requires_openai_auth=true`,
    );
  }

  return { args, env: { ...base, [TOKEN_ENV]: cfg.identityToken } };
}

const note = (s: string): void => void process.stderr.write(`fest codex: ${s}\n`);

export async function runCodex(
  argv: readonly string[],
  requested: CodexMode | "auto" = "auto",
  tagFlags: readonly string[] = [],
): Promise<void> {
  const cfg = await readCliConfig();
  if (cfg === null) throw new Error("not logged in. Run `fest login` first.");
  const tags = await sessionTags(tagFlags);
  note(describeTags(tags));

  const detected = requested === "auto" ? detectCodexMode(process.env) : null;
  const mode: CodexMode = requested === "auto" ? detected!.mode : requested;

  // Who pays, every time, as `fest claude` does.
  if (mode === "chatgpt") note(`ChatGPT login (${detected?.detail ?? "forced"}) — your own plan pays.`);
  else if (requested === "key") note("API key forced — the key's owner pays.");
  else note(`API key (${detected!.detail}) — the key's owner pays.`);

  const { args, env } = buildCodexInvocation(process.env, { ...cfg, tags }, mode);
  const child = spawn("codex", [...args, ...argv], { stdio: "inherit", env });

  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      reject(err.code === "ENOENT" ? new Error("`codex` was not found on PATH. Install Codex CLI first.") : err);
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
