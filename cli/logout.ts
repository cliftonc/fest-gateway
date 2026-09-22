/**
 * `fest logout`: forget the local token.
 *
 * Deletes `~/.fest/config.json` only. It does NOT revoke the token
 * server-side — that stays an explicit `fest token revoke <id>`, an operator
 * action against the database. This command is "forget this on my machine",
 * not a security control.
 */

import { clearCliConfig, readCliConfig } from "./config.ts";

export async function runLogout(): Promise<void> {
  const cfg = await readCliConfig();
  await clearCliConfig();
  if (cfg === null) {
    process.stdout.write("was not logged in.\n");
    return;
  }
  process.stdout.write(`removed local login for ${cfg.email}.\n`);
  process.stdout.write("the token itself is still valid until an operator revokes it with `fest token revoke <id>`.\n");
}
