import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCredential,
  partitionHeaders,
  redactSecrets,
  fingerprint,
  isSubscriptionCredential,
  SECRET_HEADERS,
} from "../server/secret/fingerprint.ts";

const FAKE_OAUTH = "sk-ant-oat01-ZZZZSECRETVALUEZZZZ";
const FAKE_API = "sk-ant-api03-YYYYSECRETVALUEYYYY";

test("distinguishes a subscription bearer from an API key", () => {
  const sub = classifyCredential("authorization", `Bearer ${FAKE_OAUTH}`);
  assert.equal(sub.kind, "ANTHROPIC_OAUTH_SUBSCRIPTION");
  assert.equal(sub.scheme, "Bearer");
  assert.ok(isSubscriptionCredential(sub));

  const key = classifyCredential("x-api-key", FAKE_API);
  assert.equal(key.kind, "ANTHROPIC_API_KEY");
  assert.equal(key.scheme, "raw");
  assert.ok(!isSubscriptionCredential(key));
});

test("classification never reveals the secret", () => {
  const info = classifyCredential("authorization", `Bearer ${FAKE_OAUTH}`);
  const serialised = JSON.stringify(info);
  // The secret tail must not survive anywhere in the record.
  assert.ok(!serialised.includes("SECRETVALUE"), "secret tail leaked");
  assert.ok(!serialised.includes(FAKE_OAUTH), "full token leaked");
  // The prefix is family-identifying only, and far too short to use.
  assert.ok(info.prefix.length <= 11);
  assert.ok(FAKE_OAUTH.startsWith(info.prefix));
});

test("fingerprints are stable and collision-resistant enough to correlate", () => {
  assert.equal(fingerprint(FAKE_OAUTH), fingerprint(FAKE_OAUTH));
  assert.notEqual(fingerprint(FAKE_OAUTH), fingerprint(FAKE_API));
  assert.equal(fingerprint(FAKE_OAUTH).length, 12);
});

test("every known credential header is treated as secret", () => {
  for (const h of ["authorization", "x-api-key", "x-anthropic-api-key", "x-fest-token", "cookie"]) {
    assert.ok(SECRET_HEADERS.has(h), `${h} must be secret`);
  }
});

test("partitionHeaders fingerprints credentials and keeps the rest", () => {
  const { credentials, plain } = partitionHeaders({
    authorization: `Bearer ${FAKE_OAUTH}`,
    "X-Fest-Token": "fest_identity_abc123456",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
  });

  assert.deepEqual(
    credentials.map((c) => c.kind).sort(),
    ["ANTHROPIC_OAUTH_SUBSCRIPTION", "FEST_IDENTITY_TOKEN"],
  );
  // Both credential positions are captured, and neither value survives.
  const dump = JSON.stringify({ credentials, plain });
  assert.ok(!dump.includes("SECRETVALUE"));
  assert.ok(!dump.includes("identity_abc123456"));
  // Non-secret headers are preserved for diagnostics, lowercased.
  assert.equal(plain["anthropic-version"], "2023-06-01");
  assert.equal(plain["anthropic-beta"], "oauth-2025-04-20");
  assert.ok(!("authorization" in plain));
});

test("log scrubber catches secrets that escape structured redaction", () => {
  assert.equal(redactSecrets(`token=${FAKE_OAUTH} done`), "token=<redacted> done");
  assert.equal(redactSecrets("key fw_abcdefgh12345"), "key <redacted>");
  assert.equal(redactSecrets("ghp_aaaaaaaaaaaaaaaa"), "<redacted>");
  // Ordinary text must survive untouched.
  assert.equal(redactSecrets("model claude-opus-5 ok"), "model claude-opus-5 ok");
});
