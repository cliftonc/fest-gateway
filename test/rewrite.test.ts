/**
 * Model rewriting.
 *
 * The rewrite is surgical rather than a JSON round trip, so the tests are
 * mostly about what it must NOT touch: a `model` key nested in a tool
 * definition or quoted inside a prompt, and — above all — `cache_control`
 * markers, whose loss silently destroys prompt caching and inflates every
 * developer's token bill.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteModel } from "../server/adapters/rewrite.ts";

const enc = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const rewrite = (json: string, model: string | null): string => dec(rewriteModel(enc(json), model));

test("the top-level model is replaced", () => {
  const out = rewrite('{"model":"claude-opus-5","max_tokens":10}', "accounts/fw/models/oss");
  assert.deepEqual(JSON.parse(out), { model: "accounts/fw/models/oss", max_tokens: 10 });
});

test("a null or empty target leaves the body byte-identical", () => {
  const body = '{"model":"claude-opus-5"}';
  assert.equal(rewrite(body, null), body);
  assert.equal(rewrite(body, ""), body);
});

test("everything except the model is left byte-for-byte alone", () => {
  // Deliberately awkward: unusual spacing, 1.0-style numbers, non-ASCII, and a
  // key order no serialiser would reproduce.
  const body =
    '{"max_tokens":1024,  "temperature":1.0,"model":"claude-opus-5","system":"café — naïve ✓","top_p":0.90}';
  const out = rewrite(body, "x");
  assert.equal(out, body.replace('"model":"claude-opus-5"', '"model": "x"'));
  assert.ok(out.includes("1.0"), "number formatting must survive");
  assert.ok(out.includes("0.90"), "trailing zeros must survive");
  assert.ok(out.includes("café — naïve ✓"), "non-ASCII must survive unescaped");
});

test("cache_control markers survive untouched", () => {
  // Losing these is a silent, expensive regression: Claude Code warns that the
  // endpoint "may be silently stripping cache_control" and every cached prompt
  // is re-billed at full rate.
  const body = JSON.stringify({
    model: "claude-opus-5",
    system: [{ type: "text", text: "big prompt", cache_control: { type: "ephemeral", ttl: "1h" } }],
  });
  const out = rewrite(body, "other");
  assert.ok(out.includes('"cache_control":{"type":"ephemeral","ttl":"1h"}'));
  assert.equal(JSON.parse(out).model, "other");
});

test("a nested model key is not rewritten", () => {
  const body = JSON.stringify({
    model: "claude-opus-5",
    tools: [{ name: "pick", input_schema: { properties: { model: { type: "string" } } } }],
    metadata: { model: "not-the-request-model" },
  });
  const parsed = JSON.parse(rewrite(body, "replaced"));
  assert.equal(parsed.model, "replaced");
  assert.equal(parsed.metadata.model, "not-the-request-model", "a nested model must be left alone");
  assert.equal(parsed.tools[0].input_schema.properties.model.type, "string");
});

test("a model name quoted inside a prompt is not rewritten", () => {
  const body = JSON.stringify({
    messages: [{ role: "user", content: 'what does "model": "claude-opus-5" mean?' }],
    model: "claude-opus-5",
  });
  const parsed = JSON.parse(rewrite(body, "replaced"));
  assert.equal(parsed.model, "replaced");
  assert.match(parsed.messages[0].content, /"model": "claude-opus-5"/, "prompt text is not config");
});

test("a body with no model is returned unchanged", () => {
  const body = '{"messages":[]}';
  assert.equal(rewrite(body, "x"), body);
});

test("malformed or non-JSON bodies are passed through rather than corrupted", () => {
  for (const body of ["", "not json at all", "{", '{"model":', "[1,2,3]"]) {
    assert.equal(rewrite(body, "x"), body, JSON.stringify(body));
  }
});

test("invalid UTF-8 is passed through untouched", () => {
  const bad = new Uint8Array(new ArrayBuffer(6));
  bad.set([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
  assert.deepEqual(rewriteModel(bad, "x"), bad);
});

test("the replacement value is JSON-escaped", () => {
  const out = rewrite('{"model":"a"}', 'we"ird\\model');
  assert.equal(JSON.parse(out).model, 'we"ird\\model');
});

test("an empty-string model in the body is still replaced", () => {
  assert.equal(JSON.parse(rewrite('{"model":""}', "x")).model, "x");
});
