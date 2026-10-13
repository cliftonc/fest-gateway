/**
 * The tag format, shared by the server (parsing what arrives) and the CLI
 * (building what it sends). A malformed tag must never fail a request, so most
 * of these are about what gets dropped rather than what throws.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TAGS,
  canonicalTags,
  formatTags,
  parseTagFilter,
  parseTagPairs,
  parseTags,
  tagPathSegment,
  tagsFromCanonical,
  tagsFromPairs,
} from "../shared/tags.ts";

test("parses comma-separated pairs, lowercasing keys and decoding both halves", () => {
  assert.deepEqual(parseTags("team=platform,Project=fest"), { team: "platform", project: "fest" });
  assert.deepEqual(parseTags(" team = Platform%20team "), { team: "Platform team" });
});

test("invalid pairs are dropped, never thrown", () => {
  assert.deepEqual(
    parseTags("noequals,=nokey,bad key=x,ok=1,slash=a%2Fb,pct=%E0%A4%A,comma=a%2Cb,eq=a%3Db"),
    { ok: "1" },
  );
  assert.deepEqual(parseTags(`long=${"x".repeat(65)}`), {});
  assert.deepEqual(parseTags(""), {});
});

test("last wins per key, and an empty value removes the key", () => {
  assert.deepEqual(parseTags("project=a,project=b"), { project: "b" });
  // The CLI's override chain: a higher layer's `project=` suppresses a default.
  const pairs = [...parseTagPairs("project=fest,team=x"), ...parseTagPairs("project=")];
  assert.deepEqual(tagsFromPairs(pairs), { team: "x" });
  assert.deepEqual(parseTags("project="), {});
});

test("at most MAX_TAGS keys are kept", () => {
  const raw = Array.from({ length: MAX_TAGS + 3 }, (_, i) => `k${i}=v`).join(",");
  assert.equal(Object.keys(parseTags(raw)).length, MAX_TAGS);
});

test("the canonical form is sorted, so one tag set is always one rollup key", () => {
  assert.equal(canonicalTags({ team: "a", project: "b" }), canonicalTags({ project: "b", team: "a" }));
  assert.equal(canonicalTags({ team: "a", project: "b" }), '{"project":"b","team":"a"}');
  assert.equal(canonicalTags({}), "");
  assert.equal(canonicalTags(undefined), "");
  assert.deepEqual(tagsFromCanonical('{"project":"b"}'), { project: "b" });
  assert.deepEqual(tagsFromCanonical("not json"), {});
  assert.deepEqual(tagsFromCanonical(""), {});
});

test("the wire form round-trips through the parser, spaces included", () => {
  const tags = { team: "Platform team", project: "fest" };
  assert.equal(formatTags(tags), "project=fest,team=Platform%20team");
  assert.deepEqual(parseTags(formatTags(tags)), tags);
  assert.equal(tagPathSegment(tags), "~project=fest,team=Platform%20team");
  assert.equal(tagPathSegment({}), "");
});

test("the dashboard filter form is key:value, with invalid entries dropped", () => {
  assert.deepEqual(parseTagFilter(["team:platform", "project:fest:x", "bad", ":x", "k:"]), {
    team: "platform",
    project: "fest:x",
  });
});
