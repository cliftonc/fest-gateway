/**
 * Secret references, and the one place they are turned into values.
 *
 * A credential is configured as a REFERENCE — `{env:FIREWORKS_API_KEY}` — not
 * as a literal. Three things follow from that, and all three are the reason it
 * is worth the indirection:
 *
 *  1. The routing config can be committed, diffed and pasted into an issue.
 *  2. The database holds no secrets by default, so a database dump is not a
 *     credential dump.
 *  3. Everything Fest records about a credential is the reference, never the
 *     value. `source: "env:FIREWORKS_API_KEY"` is meaningful to an operator and
 *     useless to an attacker.
 *
 * The resolved value is wrapped in `NonPersistable` so it cannot be logged,
 * serialised or stored by accident — see `secret/non-persistable.ts`.
 */

import { NonPersistable } from "../secret/non-persistable.ts";

/** `{env:NAME}` — the only reference form supported today. */
const ENV_REF = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

export interface SecretRef {
  readonly kind: "env";
  readonly name: string;
  /** How this reference is named in logs, records and the dashboard. */
  readonly source: string;
}

export function parseSecretRef(raw: string): SecretRef | null {
  const match = ENV_REF.exec(raw.trim());
  if (match === null) return null;
  const name = match[1] as string;
  return { kind: "env", name, source: `env:${name}` };
}

/**
 * Describe why a raw string is not a usable reference.
 *
 * Split from `parseSecretRef` so config validation can explain itself. The
 * common mistake is pasting the secret itself, and that deserves a message
 * saying so rather than a generic parse failure — otherwise the fix people
 * reach for is "quote it differently", and the key ends up in git.
 */
export function explainSecretRef(raw: string): string | null {
  const value = raw.trim();
  if (ENV_REF.test(value)) return null;
  if (value === "") return "credential is empty; expected {env:NAME}";
  if (!value.startsWith("{")) {
    return (
      `credential must be a reference like {env:NAME}, not a literal value. ` +
      `Put the secret in an environment variable and reference it, so it stays out of config and out of the database.`
    );
  }
  return `credential ${JSON.stringify(value)} is not a valid reference; expected {env:NAME}`;
}

export interface ResolvedSecret {
  readonly source: string;
  readonly value: NonPersistable<string>;
}

export interface SecretResolver {
  /** Null when the reference points at nothing. Never throws. */
  resolve(ref: SecretRef): ResolvedSecret | null;
}

/**
 * Resolve against the process environment.
 *
 * Reads on every call rather than snapshotting at boot: an operator rotating a
 * key should not have to reason about whether Fest cached the old one. The read
 * is a property lookup, so the cost is irrelevant next to a network round trip.
 *
 * An empty or whitespace-only variable counts as MISSING, not as a credential.
 * `FIREWORKS_API_KEY=` in a .env file is overwhelmingly a mistake, and treating
 * it as a real value turns a clear "not configured" into a confusing 401 from a
 * provider.
 */
export function createEnvResolver(env: NodeJS.ProcessEnv = process.env): SecretResolver {
  return {
    resolve(ref: SecretRef): ResolvedSecret | null {
      const raw = env[ref.name];
      if (raw === undefined || raw.trim() === "") return null;
      return { source: ref.source, value: new NonPersistable(raw.trim()) };
    },
  };
}
