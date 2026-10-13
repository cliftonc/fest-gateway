/**
 * `fest copilot`: run the real `copilot` binary (GitHub Copilot CLI) in its
 * bring-your-own-key mode, with Fest as the provider.
 *
 * What this is NOT: a relay for a Copilot subscription. Copilot's own model
 * traffic is authenticated with the developer's GitHub token against
 * GitHub-run endpoints, and there is no supported way to point it anywhere
 * else. BYOK (`COPILOT_PROVIDER_*`) is the supported way to put Copilot CLI on
 * a model API of your choosing, and it bills that API — so under `fest copilot`
 * a key pays, never the Copilot seat. See `docs/COPILOT.md`.
 *
 * Three modes:
 *
 *  - **anthropic** (default): Copilot speaks the Anthropic Messages API to
 *    Fest's existing `/v1/messages` on the developer's own `ANTHROPIC_API_KEY`
 *    — the same relay Claude Code's key posture uses.
 *  - **gw**: no key of the developer's; the Fest token goes in the bearer
 *    position, so the server's routing table supplies the credential, exactly
 *    as `fest claude gw` does.
 *  - **openai**: the Responses API to Fest's `/openai/v1` mount on the
 *    developer's own `OPENAI_API_KEY`.
 *
 * The identity token rides in `COPILOT_PROVIDER_HEADERS` as `X-Fest-Token`
 * (gw mode excepted), alongside `X-Fest-Client: copilot` so the dashboard can
 * tell this traffic from Claude Code's — both send `claude-*` model ids.
 */

import { spawn } from "node:child_process";
import { BASE_MODELS } from "../shared/base-models.ts";
import { readCliConfig } from "./config.ts";

export type CopilotMode = "anthropic" | "gw" | "openai";

type Env = Record<string, string | undefined>;

/**
 * Pure, so it is testable without spawning `copilot`. Throws with a sentence a
 * developer can act on when the mode needs a key that is not there.
 */
export function buildCopilotEnv(
  base: Readonly<Env>,
  cfg: { serverUrl: string; identityToken: string },
  mode: CopilotMode,
): Env {
  const env: Env = { ...base };
  // Start from a clean provider: an inherited COPILOT_PROVIDER_BEARER_TOKEN
  // silently takes precedence over the API key set below, and an inherited
  // base URL or type would point the session somewhere else entirely.
  for (const name of Object.keys(env)) {
    if (name.startsWith("COPILOT_PROVIDER_") || name === "COPILOT_PROVIDERS_CONFIG") delete env[name];
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

const note = (s: string): void => void process.stderr.write(`fest copilot: ${s}\n`);

export async function runCopilot(argv: readonly string[], mode: CopilotMode = "anthropic"): Promise<void> {
  const cfg = await readCliConfig();
  if (cfg === null) throw new Error("not logged in. Run `fest login` first.");

  const env = buildCopilotEnv(process.env, cfg, mode);
  note(
    mode === "gw"
      ? "BYOK via gateway routes — org credentials pay, not your Copilot seat."
      : `BYOK on your ${mode === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} — that key pays, not your Copilot seat.`,
  );

  const child = spawn("copilot", argv as string[], { stdio: "inherit", env });
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
