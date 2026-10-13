# Tags

Tags are `key=value` labels a client attaches to its own traffic, such as
`team=platform` or `project=fest`. Fest records them on every request, and the
dashboard can filter any page by them alongside the date range, or show
totals per tag value. `team` and `project` are conventions, not special keys.
Any key works.

Tags are **self-declared**, the same as the client label. They are for
reporting only: they never affect who is authorised, which route serves a
request, or who pays. A client that sends the wrong project only mislabels its
own usage.

## The format

```
team=platform,project=fest
```

- Pairs are separated by commas, with `=` inside each pair. Both halves are
  URL-decoded, so `team=Platform%20team` works.
- Keys are 1–32 characters of `a-z 0-9 _ . -` and are lowercased.
- Values are up to 64 characters of `A-Z a-z 0-9 space . _ : @ -`.
- At most 8 tags per request.
- A pair that breaks these rules is **dropped, never rejected**. A bad tag must
  not fail the request it is attached to.

Validation lives in `shared/tags.ts`, which the server and the CLI share.

## Two ways to send them

| carrier | form | when |
| --- | --- | --- |
| header | `x-fest-tags: team=platform,project=fest` | any client that can set headers |
| path | `…/t/<token>/~team=platform,project=fest/v1/messages` | any client that can set a base URL |

The path segment begins with `~` and goes straight after the identity prefix,
or first in the path when there is no token (`/~project=fest/v1/messages`). No
upstream API path starts with `~`. If a request carries both forms, they are
merged and the path wins for any key that appears in both.

Both are removed before anything is sent upstream. All `x-fest-*` headers are
already dropped (`server/http/headers.ts`), and the `~` segment is removed
together with the token (`server/auth/posture.ts`). Anthropic, OpenAI and
GitHub never see them, so the request a subscription login is checked against
is unchanged.

## With the fest CLI

`fest claude`, `fest codex` and `fest copilot` put tags in the path, which
works for all three clients. Copilot on its own login has no way to send
headers at all. Each command prints the tags it is using.

Layers, lowest precedence first:

1. `project=<git repo name>` when you run inside a repo
2. global saved tags: `fest tags set -g team=platform`
3. saved tags for the current directory **and every directory above it**,
   outermost first. `fest tags set team=data` in `~/work` applies to every
   repo under `~/work`, and `~/work/fest` can override it.
4. `FEST_TAGS="team=platform,project=fest"`
5. `--tag key=value` before the client's own args:
   `fest claude --tag project=spike --resume`

`fest tags set` saves for the directory you are in, because tags describe the
work, and the directory is the closest thing a laptop has to that. Use `-g`
for the few tags that follow you everywhere. Saved tags live in
`~/.fest/tags.json`, which login and logout leave alone.

An empty value removes a key that a lower layer set: `--tag project=` for one
session, or `fest tags set team=` to say "no team in this directory".

```bash
fest tags                         # the layers that apply here, and the result
fest tags set team=data           # for this directory and below
fest tags set -g team=platform    # everywhere
fest tags unset team              # from this directory (-g: from global)
```

## Without the CLI

**Claude Code**: add a header for each repo in that repo's `.claude/settings.json`:

```json
{ "env": { "ANTHROPIC_CUSTOM_HEADERS": "x-fest-tags: team=platform,project=fest" } }
```

**Codex**: add a header on the provider in `~/.codex/config.toml` or the
repo's `.codex/config.toml`:

```toml
[model_providers.fest]
http_headers = { "x-fest-tags" = "team=platform,project=fest" }
```

**Copilot CLI** on its own login can only set a URL, so the tags go in the path:

```bash
COPILOT_API_URL="https://fest.example.com/t/<token>/~project=fest/copilot/individual"
```

In BYOK mode, `COPILOT_PROVIDER_HEADERS="x-fest-tags: project=fest"` also works.

## Storage, and why tags scale

- `requests.tags_json` stores the tag set as a JSON object with sorted keys,
  or NULL for an untagged request.
- `usage_hourly.tags` is the same string (`''` for untagged) and is **part of
  the primary key** (migration 007).

Tags have to be in the hourly rollup. Ranges longer than two hours are read
from the rollup, and retention deletes raw rows while the rollup survives. A
tag stored only on raw rows would make a 30-day "project=fest" view slow at
first and then wrong.

The rollup key is the whole tag *set*, not one row per tag:

- **Writes do not grow with the number of tags.** Each request still updates
  the same four rollup rows.
- **Any combination of filters works.** Each filtered key is one
  `json_extract` condition on the set.
- **"All" needs no special case.** Every rollup query already sums across the
  dimensions it does not pin, and the tag set is one more of those.
- **The rollup stays small.** A developer uses only a few tag sets in an hour,
  so the table grows by a small factor.

The dashboard keeps its filters in the URL (`#/stats?range=7d&tag=project:fest`),
so a filtered view survives a refresh and can be shared as a link.
