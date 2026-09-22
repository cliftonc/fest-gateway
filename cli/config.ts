/**
 * The developer-facing `~/.fest` config.
 *
 * Distinct from `server/config.ts`: nothing here is read by the server, and
 * nothing in `server/config.ts` is read by the CLI. `fest login` writes this
 * file; `fest whoami`/`fest claude`/`fest logout` read or delete it. It never
 * touches the database — everything under `cli/` runs entirely on a
 * developer's own machine.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".fest");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface CliConfig {
  readonly serverUrl: string;
  readonly identityToken: string;
  readonly email: string;
  readonly provider: "google" | "github" | "env";
}

function isCliConfig(v: unknown): v is CliConfig {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["serverUrl"] === "string" &&
    typeof r["identityToken"] === "string" &&
    typeof r["email"] === "string" &&
    (r["provider"] === "google" || r["provider"] === "github" || r["provider"] === "env")
  );
}

/**
 * `FEST_TOKEN` / `FEST_SERVER_URL` override the file when both are set — the
 * CI path, where writing a config file to a shared runner's home directory
 * would be the wrong kind of persistence.
 */
export async function readCliConfig(): Promise<CliConfig | null> {
  const envToken = process.env.FEST_TOKEN;
  const envServer = process.env.FEST_SERVER_URL;
  if (envToken !== undefined && envToken !== "" && envServer !== undefined && envServer !== "") {
    return {
      serverUrl: envServer.replace(/\/+$/, ""),
      identityToken: envToken,
      email: "(FEST_TOKEN)",
      provider: "env",
    };
  }

  let raw: string;
  try {
    raw = await readFile(CONFIG_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  return isCliConfig(parsed) ? parsed : null;
}

export async function writeCliConfig(cfg: CliConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

export async function clearCliConfig(): Promise<void> {
  await rm(CONFIG_FILE, { force: true });
}
