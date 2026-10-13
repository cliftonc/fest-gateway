/**
 * Dashboard filter state in the hash. The property that matters is that a
 * refresh reopens the same view, so these are round-trips: what a control
 * writes must be exactly what the page reads back.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHash, globalParams, parseHash, readParam, withParam } from "../web/src/lib/url-state.ts";
import { formatTagFilter, parseTagFilter } from "../shared/tags.ts";

test("page and params round-trip through the hash", () => {
  const params = new URLSearchParams();
  params.append("range", "7d");
  params.append("tag", "project:fest");
  params.append("tag", "team:Platform team");
  const hash = buildHash("stats", params);
  const back = parseHash(hash);
  assert.equal(back.page, "stats");
  assert.equal(back.params.get("range"), "7d");
  assert.deepEqual(parseTagFilter(back.params.getAll("tag")), { project: "fest", team: "Platform team" });
});

test("a hash with no query, or no hash at all, still parses", () => {
  assert.deepEqual([...parseHash("#/models").params], []);
  assert.equal(parseHash("#/models").page, "models");
  assert.equal(parseHash("#models").page, "models");
  assert.equal(parseHash("").page, "");
  assert.equal(buildHash("live", new URLSearchParams()), "#/live");
});

test("the default value is left out of the URL; null removes; lists repeat", () => {
  const base = new URLSearchParams("range=7d&window=60000");
  assert.equal(withParam(base, "range", "24h", "24h").has("range"), false);
  assert.equal(withParam(base, "window", null).has("window"), false);
  const tagged = withParam(base, "tag", formatTagFilter({ team: "a", project: "b" }));
  assert.deepEqual(tagged.getAll("tag"), ["project:b", "team:a"]);
  assert.deepEqual(withParam(tagged, "tag", []).getAll("tag"), []);
  assert.equal(base.get("range"), "7d", "the input is not mutated");
});

test("an unknown value reads as the default instead of breaking the page", () => {
  const p = new URLSearchParams("range=forever");
  assert.equal(readParam(p, "range", ["1h", "24h"], "24h"), "24h");
  assert.equal(readParam(new URLSearchParams("range=1h"), "range", ["1h", "24h"], "24h"), "1h");
});

test("only range and tags follow the reader to another page", () => {
  const p = new URLSearchParams("range=7d&tag=project:fest&window=60000&by=team");
  assert.equal(globalParams(p).toString(), "range=7d&tag=project%3Afest");
});
