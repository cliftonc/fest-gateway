/**
 * Entity ids: `<kind>_<hex>`.
 *
 * Kind-prefixed so an id is self-describing in a log line or a URL, and so a
 * user id pasted where a token id belongs fails obviously instead of silently
 * matching nothing.
 */

import { randomUUID } from "node:crypto";

export type IdPrefix = "org" | "usr" | "tok" | "ses";

export function newId(prefix: IdPrefix): string {
  // Dashes stripped: the id ends up in URLs and CLI args, and 32 hex chars
  // avoid any question about what is a separator.
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
