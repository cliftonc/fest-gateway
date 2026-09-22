/**
 * Google/GitHub OAuth provider construction.
 *
 * Returns null rather than throwing when a provider's client id/secret are
 * unset — a deployment may intentionally run with only one provider
 * configured, or with neither and password-only dashboard login. Same shape
 * as an unconfigured routing upstream (Phase 4): a feature that refuses to
 * activate, not a boot failure.
 */

import { Google, GitHub } from "arctic";
import type { FestConfig } from "../config.ts";

export type OauthProvider = "google" | "github";

export function oauthRedirectUri(cfg: FestConfig, provider: OauthProvider): string {
  return `${cfg.publicUrl}/api/auth/oauth/${provider}/callback`;
}

export function googleProvider(cfg: FestConfig): Google | null {
  if (cfg.googleClientId === null || cfg.googleClientSecret === null) return null;
  return new Google(cfg.googleClientId, cfg.googleClientSecret, oauthRedirectUri(cfg, "google"));
}

export function githubProvider(cfg: FestConfig): GitHub | null {
  if (cfg.githubClientId === null || cfg.githubClientSecret === null) return null;
  return new GitHub(cfg.githubClientId, cfg.githubClientSecret, oauthRedirectUri(cfg, "github"));
}

export function configuredProviders(cfg: FestConfig): readonly OauthProvider[] {
  const out: OauthProvider[] = [];
  if (googleProvider(cfg) !== null) out.push("google");
  if (githubProvider(cfg) !== null) out.push("github");
  return out;
}

/**
 * Empty allow-list refuses every OAuth login, deliberately. Self-service token
 * minting spends server-held credentials on the substitute path, so "nobody
 * configured a domain" must mean "OAuth login is off", not "everyone is in".
 */
export function emailDomainAllowed(cfg: FestConfig, email: string): boolean {
  if (cfg.allowedEmailDomains.length === 0) return false;
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return cfg.allowedEmailDomains.includes(domain);
}
