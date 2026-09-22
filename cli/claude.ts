/**
 * `fest claude`: run the real `claude` binary, pointed at this developer's
 * Fest gateway.
 *
 * Sets `ANTHROPIC_BASE_URL` to the path-prefixed identity carrier
 * (`server/auth/posture.ts`'s `parseIdentityPath`) and strips every demotion
 * var so the child can't be silently downgraded off the developer's own
 * subscription — the same reasoning `tools/canary.ts` applies to its test
 * client, from the same `shared/demotion-vars.ts` list.
 */

import { spawn } from "node:child_process";
import { DEMOTION_VARS } from "../shared/demotion-vars.ts";
import { readCliConfig } from "./config.ts";

/** Pure, so it's testable without spawning a real `claude` binary. */
export function buildClaudeEnv(
  base: Readonly<Record<string, string | undefined>>,
  cfg: { serverUrl: string; identityToken: string },
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const v of DEMOTION_VARS) delete env[v];
  env["ANTHROPIC_BASE_URL"] = `${cfg.serverUrl}/t/${cfg.identityToken}`;
  return env;
}

export async function runClaude(argv: readonly string[]): Promise<void> {
  const cfg = await readCliConfig();
  if (cfg === null) {
    throw new Error("not logged in. Run `fest login` first.");
  }

  const env = buildClaudeEnv(process.env, cfg);

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
