/**
 * Anthropic's own current base models, shared between the gateway menu and the
 * `fest claude` preflight. Keeping one list prevents the CLI from warning about
 * a model the server no longer considers a base, and prevents the server from
 * offering a model the CLI does not know to check.
 */

export interface BaseModel {
  readonly id: string;
  readonly name: string;
}

export const BASE_MODELS: ReadonlyArray<BaseModel> = [
  { id: "claude-opus-5", name: "Opus 5" },
  { id: "claude-sonnet-5", name: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" },
] as const;
