/**
 * Guards the one distinction the whole gateway rests on: the developer's
 * upstream credential vs Fest's own identity token. Conflating them either
 * leaks our bearer upstream or (worse) bills the org because subscription auth
 * was abandoned.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectInbound, parseIdentityPath } from "../server/auth/posture.ts";

const OAUTH = "sk-ant-oat01-AAAAPOSTUREFIXTUREAAAA";
const API_KEY = "sk-ant-api03-BBBBPOSTUREFIXTUREBBBB";
const FEST_TOKEN = "fest_identityFIXTURE1234";

const PATH = "/v1/messages?beta=true";

interface Case {
  readonly name: string;
  readonly headers: Record<string, string>;
  readonly posture: "subscription" | "key";
  readonly credentialKind: string | null;
  readonly credentialHeader: string | null;
  readonly carrier: "path" | "header" | "none";
}

const CASES: readonly Case[] = [
  {
    name: "OAuth bearer only",
    headers: { authorization: `Bearer ${OAUTH}` },
    posture: "subscription",
    credentialKind: "ANTHROPIC_OAUTH_SUBSCRIPTION",
    credentialHeader: "authorization",
    carrier: "none",
  },
  {
    name: "API key via x-api-key",
    headers: { "x-api-key": API_KEY },
    posture: "key",
    credentialKind: "ANTHROPIC_API_KEY",
    credentialHeader: "x-api-key",
    carrier: "none",
  },
  {
    name: "API key via Authorization bearer",
    headers: { authorization: `Bearer ${API_KEY}` },
    posture: "key",
    credentialKind: "ANTHROPIC_API_KEY",
    credentialHeader: "authorization",
    carrier: "none",
  },
  {
    name: "no credential at all",
    headers: {},
    posture: "key",
    credentialKind: null,
    credentialHeader: null,
    carrier: "none",
  },
  {
    name: "OAuth bearer plus X-Fest-Token",
    headers: { authorization: `Bearer ${OAUTH}`, "x-fest-token": FEST_TOKEN },
    posture: "subscription",
    credentialKind: "ANTHROPIC_OAUTH_SUBSCRIPTION",
    credentialHeader: "authorization",
    carrier: "header",
  },
];

for (const c of CASES) {
  test(`detectInbound: ${c.name}`, () => {
    const got = detectInbound(PATH, c.headers);
    assert.equal(got.posture, c.posture);
    assert.equal(got.identity.carrier, c.carrier);
    if (c.credentialKind === null) {
      assert.equal(got.upstreamCredential, null);
    } else {
      assert.equal(got.upstreamCredential?.kind, c.credentialKind);
      assert.equal(got.upstreamCredential?.header, c.credentialHeader);
    }
    assert.equal(got.effectivePath, PATH);
  });
}

test("the Fest identity token is never mistaken for the upstream credential", () => {
  // Both are secret headers, but only one goes to Anthropic.
  const got = detectInbound(PATH, {
    authorization: `Bearer ${OAUTH}`,
    "x-fest-token": FEST_TOKEN,
  });
  assert.equal(got.posture, "subscription");
  assert.equal(got.upstreamCredential?.header, "authorization");
  assert.notEqual(got.upstreamCredential?.kind, "FEST_IDENTITY_TOKEN");
  assert.equal(got.identityToken, FEST_TOKEN);
  assert.equal(got.identity.carrier, "header");
});

test("a Fest token alone does not make a credential posture claim", () => {
  const got = detectInbound(PATH, { "x-fest-token": FEST_TOKEN });
  assert.equal(got.upstreamCredential, null);
  assert.equal(got.posture, "key");
  assert.equal(got.identity.carrier, "header");
});

test("identity fingerprint is recorded, raw token is not derivable from it", () => {
  const got = detectInbound(PATH, { "x-fest-token": FEST_TOKEN });
  assert.ok(got.identity.tokenFingerprint);
  assert.ok(!got.identity.tokenFingerprint!.includes("FIXTURE"));
});

test("path identity: token is stripped and the query string survives", () => {
  const got = parseIdentityPath(`/t/${FEST_TOKEN}/v1/messages?beta=true`);
  assert.equal(got.token, FEST_TOKEN);
  assert.equal(got.remainder, "/v1/messages?beta=true");
});

test("path identity: the /fest/ long form works the same way", () => {
  const got = parseIdentityPath(`/fest/${FEST_TOKEN}/v1/messages?beta=true`);
  assert.equal(got.token, FEST_TOKEN);
  assert.equal(got.remainder, "/v1/messages?beta=true");
});

test("a normal /v1/messages path is never mis-parsed as an identity prefix", () => {
  const got = parseIdentityPath("/v1/messages?beta=true");
  assert.equal(got.token, null);
  assert.equal(got.remainder, "/v1/messages?beta=true");
});

test("path identity with no trailing path still addresses /", () => {
  const got = parseIdentityPath(`/t/${FEST_TOKEN}`);
  assert.equal(got.token, FEST_TOKEN);
  assert.equal(got.remainder, "/");
});

test("path identity with a bare trailing slash addresses /", () => {
  const got = parseIdentityPath(`/t/${FEST_TOKEN}/`);
  assert.equal(got.token, FEST_TOKEN);
  assert.equal(got.remainder, "/");
});

test("path identity with only a query string keeps the query", () => {
  const got = parseIdentityPath(`/t/${FEST_TOKEN}?beta=true`);
  assert.equal(got.token, FEST_TOKEN);
  assert.equal(got.remainder, "/?beta=true");
});

test("the path carrier wins when both carriers are present", () => {
  const got = detectInbound(`/t/${FEST_TOKEN}/v1/messages?beta=true`, {
    authorization: `Bearer ${OAUTH}`,
    "x-fest-token": "fest_someOtherStaleToken",
  });
  assert.equal(got.identity.carrier, "path");
  assert.equal(got.identityToken, FEST_TOKEN);
  assert.equal(got.effectivePath, "/v1/messages?beta=true");
});

test("a blank authorization header does not mask x-api-key", () => {
  const got = detectInbound(PATH, { authorization: "", "x-api-key": API_KEY });
  assert.equal(got.upstreamCredential?.header, "x-api-key");
  assert.equal(got.posture, "key");
});

test("header lookup is case-insensitive", () => {
  const got = detectInbound(PATH, { Authorization: `Bearer ${OAUTH}`, "X-Fest-Token": FEST_TOKEN });
  assert.equal(got.posture, "subscription");
  assert.equal(got.identity.carrier, "header");
});
