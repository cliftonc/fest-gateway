-- Which coding agent sent each request: 'claude-code', 'codex' or 'copilot'.
--
-- Fest fronted only Claude Code until the `/openai` and `/chatgpt` mounts
-- (Codex) and Copilot CLI's BYOK mode. Model ids mostly tell the clients apart,
-- but not reliably — Copilot BYOK sends the same `claude-*` ids Claude Code
-- does — and "how much of our spend is Codex" is a question per client, not
-- per model.
--
-- Labelled from caller-controlled headers (see server/http/client.ts), so it is
-- reporting, never policy. NULL is "could not tell", which is also every row
-- written before this migration: they were almost certainly Claude Code, but a
-- guess written into history is exactly what this schema refuses to do.

ALTER TABLE requests ADD COLUMN client TEXT;
