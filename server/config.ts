/**
 * Configuration, entirely from the environment.
 *
 * Validated once at boot and printed as a redacted table, so a
 * misconfiguration fails loudly at startup rather than lazily on the first
 * developer's request.
 */

export interface FestConfig {
  readonly port: number;
  readonly host: string;
  readonly upstreamBaseUrl: string;
  readonly usageLogPath: string;
  readonly dbPath: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  /**
   * When false, a request with no Fest identity token is served anyway and
   * recorded as unattributed. Useful for a single-developer trial; wrong for a
   * team, where unattributed usage defeats the purpose.
   */
  readonly requireIdentity: boolean;
  /**
   * Path to the routing table, or null for "everything passes through".
   *
   * Null is the DEFAULT and the safe one: with no config, Fest can only ever
   * relay a request to Anthropic on the caller's own credential. Substitution
   * — org spend, a different vendor seeing the traffic — requires an operator
   * to have written a file saying so.
   */
  readonly routesPath: string | null;
  /**
   * Marks the dashboard session cookie `Secure` and gives it the `__Host-`
   * prefix. Set it whenever Fest is reached over HTTPS — including behind a TLS
   * terminating proxy, where the server itself only ever sees plain HTTP and so
   * cannot work this out for itself.
   *
   * Defaults to false so a loopback trial over http:// can log in at all: a
   * Secure cookie on an http:// origin is silently dropped by the browser,
   * which presents as "login succeeds, then immediately signs me out".
   */
  readonly secureCookies: boolean;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${name} must be a boolean, got ${JSON.stringify(raw)}`);
}

export function loadConfig(): FestConfig {
  const level = (process.env.FEST_LOG_LEVEL ?? "info").trim() as FestConfig["logLevel"];
  if (!["debug", "info", "warn", "error"].includes(level)) {
    throw new Error(`FEST_LOG_LEVEL must be debug|info|warn|error, got ${JSON.stringify(level)}`);
  }

  const upstream = (process.env.FEST_UPSTREAM_BASE_URL ?? "https://api.anthropic.com").trim();
  try {
    new URL(upstream);
  } catch {
    throw new Error(`FEST_UPSTREAM_BASE_URL is not a valid URL: ${JSON.stringify(upstream)}`);
  }

  return {
    port: intFromEnv("FEST_PORT", 8787),
    host: (process.env.FEST_HOST ?? "127.0.0.1").trim(),
    upstreamBaseUrl: upstream.replace(/\/+$/, ""),
    usageLogPath: (process.env.FEST_USAGE_LOG ?? "./data/usage.jsonl").trim(),
    dbPath: (process.env.FEST_DB ?? "./data/fest.db").trim(),
    logLevel: level,
    requireIdentity: boolFromEnv("FEST_REQUIRE_IDENTITY", false),
    routesPath: (process.env.FEST_ROUTES ?? "").trim() || null,
    secureCookies: boolFromEnv("FEST_SECURE_COOKIES", false),
  };
}

/** Safe to log: contains no secrets by construction. */
export function describeConfig(cfg: FestConfig): Record<string, unknown> {
  return { ...cfg };
}
