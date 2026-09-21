/**
 * Structured logging with mandatory redaction.
 *
 * Every line passes through `redactSecrets` regardless of origin. Redaction
 * that depends on each call site remembering to sanitise its own input fails
 * eventually, and in Fest the thing that leaks would be a developer's live
 * subscription credential. So the scrubber is applied here, once, to the
 * serialised output — belt and braces over the structured fingerprinting that
 * should already have happened upstream.
 */

import { redactSecrets } from "./secret/fingerprint.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = LEVEL_ORDER.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVEL_ORDER[level];
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const line = JSON.stringify({ at: new Date().toISOString(), level, msg, ...fields });
  const safe = redactSecrets(line);
  // Logs go to stderr so stdout stays free for machine-readable output.
  process.stderr.write(safe + "\n");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
