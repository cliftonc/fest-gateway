/**
 * Anthropic's own current base models, shared between the gateway menu, the
 * `fest claude` preflight and the Routing screen's classification. Keeping one
 * list prevents the CLI from warning about a model the server no longer
 * considers a base, and prevents the server from offering a model the CLI does
 * not know to check.
 *
 * A model missing from here is not a cosmetic gap. Three things go quietly
 * wrong: the gateway menu never offers it, `fest claude` never warns that this
 * gateway cannot serve it, and the dashboard files a rule that redirects it
 * under "models this gateway adds" instead of "substitutions" — which is the
 * heading an operator reads as harmless.
 *
 * Checked against the lineup table at
 * platform.claude.com/docs/en/docs/about-claude/models/overview on 2026-09-22.
 * Ids are the Claude API ids; from the 4.6 generation on, a dateless id is
 * itself a pinned snapshot, which is why only Haiku carries a date. Legacy
 * models that are still servable (Fable 5, Opus 4.8 and earlier, Sonnet 4.6
 * and earlier) are deliberately absent: this is the list Fest offers and
 * checks, not an archive.
 */

export interface BaseModel {
  readonly id: string;
  readonly name: string;
}

export const BASE_MODELS: ReadonlyArray<BaseModel> = [
  { id: "claude-fable-5-1", name: "Fable 5.1" },
  { id: "claude-opus-5", name: "Opus 5" },
  { id: "claude-sonnet-5", name: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" },
] as const;
