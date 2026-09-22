# test/

Node's built-in test runner, no framework, no config beyond the `npm test`
script (`node --test "test/**/*.test.ts"`). Flat directory — no
subdirectories by feature or layer, except `fixtures/` for canned data files.

Naming convention: `<feature>.test.ts` for unit-level tests,
`<feature>-http.test.ts` (or `-integration.test.ts`) when a test drives a real
socket, a real SQLite file, or a real child process instead of mocking the
layer underneath. Both exist for several features on purpose (e.g.
`auth.test.ts` + `auth-http.test.ts`, `oauth.test.ts` + `oauth-http.test.ts`) —
the unit test proves the logic, the HTTP test proves the wiring, which is
where a surprising number of this project's real bugs have actually lived.

## Maintaining this

- **Prefer a real dependency over a mock wherever practical.** This repo's own
  history (see the progress log in the plan docs) is a list of bugs that only
  a real writer, a real query layer, or a real HTTP server surfaced — mocks
  were consistently "too clean" to reproduce them. A new integration test
  should exercise the actual `server/store` writer and query layer, not a
  fake standing in for both.
- New test files are picked up automatically by the glob; no registration
  step. Match an existing file's structure (harness function, `t.after` for
  cleanup, a small `call()`/`get()` helper) rather than inventing a new
  pattern.
- If a test needs to isolate `~/.fest` or similar user-global state, override
  `process.env.HOME` and dynamically `import()` the module under test
  *after* that, since config paths are computed once at import time (see
  `cli-config.test.ts` / `cli-login.test.ts` for the pattern).
