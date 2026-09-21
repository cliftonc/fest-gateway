#!/usr/bin/env node
/**
 * Re-extract Claude Code's embedded gateway protocol document.
 *
 * The client binary is a Bun standalone executable with the JS bundle inside.
 * The document lives in a template literal, so the extraction is: find a stable
 * anchor heading, walk back to the document's start, forward to the closing
 * backtick, then undo the JS string escaping.
 *
 * Anchored on headings rather than byte offsets so it survives a version bump
 * moving things around. If the anchor disappears entirely, that is itself worth
 * knowing — the surface has changed.
 *
 *   node tools/extract-gateway-doc.mjs [path-to-claude-binary] > out.md
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT = join(homedir(), ".local/share/claude/versions/2.1.278");
const binary = process.argv[2] ?? DEFAULT;

const ANCHOR = "## Models \\u2014 optional";
const START = "\n## Flow\n";

const text = readFileSync(binary, "latin1");
const anchor = text.indexOf(ANCHOR);
if (anchor === -1) {
  process.stderr.write(
    `extract-gateway-doc: anchor not found in ${binary}.\n` +
      `The document may have moved, changed, or been removed — worth investigating rather than ignoring.\n`,
  );
  process.exit(1);
}

const start = text.lastIndexOf(START, anchor);
let end = anchor;
for (;;) {
  end = text.indexOf("`", end + 1);
  if (end === -1) break;
  if (text[end - 1] !== "\\") break;
}
if (start === -1 || end === -1) {
  process.stderr.write("extract-gateway-doc: could not determine document bounds.\n");
  process.exit(1);
}

const doc = Buffer.from(text.slice(start, end), "latin1")
  .toString("utf8")
  .replaceAll("\\u2014", "—")
  .replaceAll("\\`", "`")
  .replaceAll("\\n", "\n")
  .replaceAll("\\'", "'")
  .replaceAll('\\"', '"')
  .replaceAll("\\\\", "\\");

process.stdout.write(doc);
