/**
 * The routing table: which model goes where, and on whose credential.
 *
 * Loaded from a JSON file (`FEST_ROUTES`), validated in full at boot, and
 * immutable thereafter. Validation is deliberately strict and noisy — a
 * mistyped upstream name that silently disables a route would send traffic to
 * Anthropic on a developer's subscription when the operator believed it was
 * going to Fireworks, and nothing would say so. Every rejection names the
 * offending entry.
 *
 * The plan's eventual design is a versioned, published, ETagged table in
 * SQLite so an admin UI can edit it. That is deferred: it only earns its
 * complexity once something can edit it, and nothing can until the admin work
 * lands. A file is diffable, reviewable and atomic to deploy, which covers the
 * spike. The parsed shape is what the store would hold, so that migration is
 * additive.
 *
 * Example:
 *
 * {
 *   "upstreams": {
 *     "fireworks": {
 *       "adapter": "fireworks",
 *       "baseUrl": "https://api.fireworks.ai/inference",
 *       "credential": "{env:FIREWORKS_API_KEY}"
 *     }
 *   },
 *   "routes": [
 *     { "id": "oss-120b",
 *       "match": "gpt-oss-120b",
 *       "upstream": "fireworks",
 *       "model": "accounts/fireworks/models/gpt-oss-120b" }
 *   ]
 * }
 */

import { explainSecretRef, parseSecretRef } from "../credentials/provider.ts";
import type { SecretRef } from "../credentials/provider.ts";

/** Adapters that exist. Anything else is a config error, not a silent no-op. */
export const ADAPTERS = ["anthropic", "fireworks"] as const;
export type AdapterId = (typeof ADAPTERS)[number];

export interface Upstream {
  readonly id: string;
  readonly adapter: AdapterId;
  readonly baseUrl: string;
  /**
   * The server-held credential for this upstream. Always a reference; the
   * value is never in config and never in the database.
   */
  readonly credential: SecretRef;
}

export interface Route {
  readonly id: string;
  /**
   * Model id to match. A trailing `*` matches a prefix; anything else is exact.
   *
   * No regular expressions, on purpose: a routing table is read under pressure
   * during an incident, and `claude-*` is unambiguous to everyone in the room
   * in a way that `^claude-(?!opus).*$` is not.
   */
  readonly match: string;
  /** Upstream id, or null to mean "keep this on the pass-through path". */
  readonly upstream: string | null;
  /** Model id to send upstream. Defaults to the requested id. */
  readonly model: string | null;
  /**
   * An extra id to publish in the `/model` menu, which also routes here.
   *
   * Necessary because Claude Code DEDUPES gateway entries against its built-in
   * list: publishing `claude-sonnet-5` collides with the built-in Sonnet and is
   * silently dropped, so a substituted model never shows its destination in the
   * picker. An alias like `claude-sonnet-5-fireworks` does not collide, appears
   * under "From gateway", and makes choosing the substitute a deliberate act
   * rather than something that happens to a developer.
   *
   * It must still look Anthropic-ish: the client filters ids by
   * `/(claude|anthropic)/i` and its model-family logic keys on the
   * `claude-{family}-…` shape.
   */
  readonly expose: string | null;
}

export interface RouteTable {
  readonly upstreams: ReadonlyMap<string, Upstream>;
  readonly routes: readonly Route[];
  /** Content hash. Becomes the ETag when this table is served over HTTP. */
  readonly version: string;
}

export class RouteConfigError extends Error {
  constructor(problems: readonly string[]) {
    super(
      `Fest routing config is invalid:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\n\nFest will not start with a routing table it cannot honour: a route that\n` +
        `silently does not apply sends traffic somewhere the operator did not intend.`,
    );
    this.name = "RouteConfigError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Cheap, stable content hash. Not cryptographic — it identifies, not protects. */
function hashOf(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2654435761) >>> 0;
  }
  return (h1.toString(16) + h2.toString(16)).padStart(16, "0");
}

export function parseRouteTable(text: string): RouteTable {
  const problems: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new RouteConfigError([`not valid JSON: ${(err as Error).message}`]);
  }
  if (!isRecord(raw)) throw new RouteConfigError(["top level must be an object"]);

  // ── upstreams ───────────────────────────────────────────────────────────────
  const upstreams = new Map<string, Upstream>();
  /**
   * Upstreams that were declared but failed validation.
   *
   * Tracked separately so one root cause produces one message. Without this, a
   * mistyped credential on `fireworks` reports both "bad credential" AND
   * "unknown upstream fireworks" for every route that referenced it — and an
   * operator reading a wall of cascading errors is materially more likely to
   * fix the wrong one.
   */
  const declared = new Set<string>();
  const rawUpstreams = raw["upstreams"];
  if (rawUpstreams !== undefined) {
    if (!isRecord(rawUpstreams)) {
      problems.push("`upstreams` must be an object keyed by upstream id");
    } else {
      for (const [id, value] of Object.entries(rawUpstreams)) {
        const at = `upstream ${JSON.stringify(id)}`;
        declared.add(id);
        if (!isRecord(value)) {
          problems.push(`${at}: must be an object`);
          continue;
        }

        const adapter = value["adapter"];
        if (typeof adapter !== "string" || !(ADAPTERS as readonly string[]).includes(adapter)) {
          problems.push(
            `${at}: adapter must be one of ${ADAPTERS.join(", ")} (got ${JSON.stringify(adapter)})`,
          );
          continue;
        }

        const baseUrl = value["baseUrl"];
        if (typeof baseUrl !== "string") {
          problems.push(`${at}: baseUrl is required`);
          continue;
        }
        try {
          const parsed = new URL(baseUrl);
          // A credential sent over plaintext HTTP is a credential disclosed.
          // Loopback is exempt so a local mock upstream stays testable.
          if (
            parsed.protocol !== "https:" &&
            !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
          ) {
            problems.push(
              `${at}: baseUrl must be https (a server-held credential would otherwise cross the network in plaintext)`,
            );
          }
        } catch {
          problems.push(`${at}: baseUrl is not a valid URL: ${JSON.stringify(baseUrl)}`);
          continue;
        }

        const credential = value["credential"];
        if (typeof credential !== "string") {
          problems.push(`${at}: credential is required, as a reference like {env:NAME}`);
          continue;
        }
        const why = explainSecretRef(credential);
        if (why !== null) {
          problems.push(`${at}: ${why}`);
          continue;
        }

        upstreams.set(id, {
          id,
          adapter: adapter as AdapterId,
          baseUrl: baseUrl.replace(/\/+$/, ""),
          credential: parseSecretRef(credential) as SecretRef,
        });
      }
    }
  }

  // ── routes ──────────────────────────────────────────────────────────────────
  const routes: Route[] = [];
  const rawRoutes = raw["routes"];
  const seenIds = new Set<string>();
  const exposed = new Set<string>();
  if (rawRoutes !== undefined) {
    if (!Array.isArray(rawRoutes)) {
      problems.push("`routes` must be an array");
    } else {
      rawRoutes.forEach((value, index) => {
        const at = `route #${index}`;
        if (!isRecord(value)) {
          problems.push(`${at}: must be an object`);
          return;
        }

        const id = value["id"];
        if (typeof id !== "string" || id.trim() === "") {
          problems.push(`${at}: id is required (it names this decision in every usage record)`);
          return;
        }
        if (seenIds.has(id)) {
          problems.push(`${at}: duplicate route id ${JSON.stringify(id)}`);
          return;
        }
        seenIds.add(id);

        const match = value["match"];
        if (typeof match !== "string" || match.trim() === "") {
          problems.push(`route ${JSON.stringify(id)}: match is required`);
          return;
        }
        if (match.indexOf("*") !== -1 && !match.endsWith("*")) {
          problems.push(
            `route ${JSON.stringify(id)}: '*' is only supported as a trailing wildcard (got ${JSON.stringify(match)})`,
          );
          return;
        }

        const upstream = value["upstream"] ?? null;
        if (upstream !== null && typeof upstream !== "string") {
          problems.push(`route ${JSON.stringify(id)}: upstream must be a string or null`);
          return;
        }
        if (typeof upstream === "string" && !upstreams.has(upstream)) {
          if (!declared.has(upstream)) {
            problems.push(
              `route ${JSON.stringify(id)}: unknown upstream ${JSON.stringify(upstream)}. ` +
                `Known: ${[...declared].join(", ") || "(none)"}`,
            );
          }
          // Declared-but-invalid: its own error is already reported above, and
          // repeating it per referencing route buries the root cause.
          return;
        }

        const model = value["model"] ?? null;
        if (model !== null && typeof model !== "string") {
          problems.push(`route ${JSON.stringify(id)}: model must be a string or null`);
          return;
        }

        const expose = value["expose"] ?? null;
        if (expose !== null && typeof expose !== "string") {
          problems.push(`route ${JSON.stringify(id)}: expose must be a string or null`);
          return;
        }
        if (typeof expose === "string") {
          if (expose.includes("*")) {
            problems.push(
              `route ${JSON.stringify(id)}: expose must be a concrete id, not a pattern — it is what a developer selects`,
            );
            return;
          }
          // Publishing an id the client filters out is worse than not
          // publishing: the entry vanishes rather than erroring, and the
          // operator has no way to tell the difference.
          if (!/(claude|anthropic)/i.test(expose)) {
            problems.push(
              `route ${JSON.stringify(id)}: expose ${JSON.stringify(expose)} does not match /(claude|anthropic)/i, ` +
                `so Claude Code would silently drop it from the model menu`,
            );
            return;
          }
          if (exposed.has(expose)) {
            problems.push(`route ${JSON.stringify(id)}: expose ${JSON.stringify(expose)} is already used by another route`);
            return;
          }
          exposed.add(expose);
        }

        routes.push({ id, match, upstream, model, expose });
      });
    }
  }

  // An upstream nothing routes to is dead config. It is a warning-shaped
  // problem, but it is raised as an error for the same reason as the rest: the
  // operator believes traffic is going there, and it is not.
  for (const [id, upstream] of upstreams) {
    // An `anthropic` upstream is reachable with no route pointing at it: it is
    // the default destination for Anthropic models in the key posture, where
    // there is no caller credential to pass through. See
    // `resolveWithoutCallerCredential`. Demanding a route per model id here
    // would be config whose only purpose is to satisfy this check.
    if (upstream.adapter === "anthropic") continue;
    if (!routes.some((r) => r.upstream === id)) {
      problems.push(
        `upstream ${JSON.stringify(id)} is defined but no route targets it, so nothing will ever reach it`,
      );
    }
  }

  if (problems.length > 0) throw new RouteConfigError(problems);

  return { upstreams, routes, version: hashOf(text) };
}

/** The table used when no routing config is present: everything passes through. */
export const EMPTY_ROUTE_TABLE: RouteTable = {
  upstreams: new Map(),
  routes: [],
  version: "empty",
};
