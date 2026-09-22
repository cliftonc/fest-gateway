/**
 * `fest whoami`: what's stored locally, plus a live check against the server.
 */

import { readCliConfig } from "./config.ts";

const out = (s: string): void => void process.stdout.write(s + "\n");

export async function runWhoami(): Promise<void> {
  const cfg = await readCliConfig();
  if (cfg === null) {
    out("not logged in. Run `fest login` first.");
    return;
  }

  out(`email    : ${cfg.email}`);
  out(`provider : ${cfg.provider}`);
  out(`server   : ${cfg.serverUrl}`);

  try {
    const res = await fetch(`${cfg.serverUrl}/api/auth/identity`, {
      headers: { authorization: `Bearer ${cfg.identityToken}` },
    });
    if (res.ok) {
      const body = (await res.json()) as { email: string };
      out(`status   : token is live (server sees ${body.email})`);
    } else if (res.status === 401) {
      out("status   : token was revoked or is invalid. Run `fest login` again.");
    } else {
      out(`status   : could not confirm (HTTP ${res.status})`);
    }
  } catch (err) {
    out(`status   : could not reach ${cfg.serverUrl} (${err instanceof Error ? err.message : String(err)})`);
  }
}
