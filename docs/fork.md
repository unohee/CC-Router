# This fork

CC-Router here is a fork of [VictorMinemu/CC-Router](https://github.com/VictorMinemu/CC-Router).
It diverged at `d770488` (v0.6.2, 2026-06-06) and stopped tracking upstream on 2026-10-14.
On 2026-10-16 it also left GitHub's fork network (it stays public), so the two repositories
are no longer linked there — pull requests open against this tree, not upstream's.

Upstream is now a read-only source: a place to cherry-pick from, not a branch to merge.
The remotes say so: `origin` is this repository and `upstream` is VictorMinemu's, with its
push URL disabled.

## Why it forked

By October 2026 this tree was 31 commits and roughly 7,600 added lines ahead of upstream,
across 60 files, and most of that is not generally applicable. Session affinity, the quota
soft cap, the request throttle, the context guard and the operational fixes around them
exist because this router runs as a shared server for several accounts at once. Upstream is
a single-user tool. Carrying the work as a permanent rebase against a project with different
goals cost more than it returned, and the one PR that did land (#9) came back reshaped
enough that the two editions of it no longer merged cleanly.

## What was taken from upstream at the fork point

`a3651b2` records `d770488..555980d` as the divergence point without taking upstream's tree.
A content merge was not possible: upstream's `04e5dd1` and our `9194727` are the same
tool-call bridge work, by the same author on the same day, diverged in form after review —
so a three-way merge pitted two editions of one change against each other across ten files.

Upstream's two genuine improvements on top of that shared base were ported deliberately,
with their tests and their original authorship:

| Upstream | What | Here |
|---|---|---|
| `08c69cb` | Tool arguments delivered whole, with no preceding delta | `a9e004d` |
| `0c91943` | Fail closed on an invalid tool stream | `febc7f8`, `c7966a7` |

One more change came from this fork's own history rather than upstream: fork PR #2
(`3209acb`, now `d0b0f68`), which separates "is the response finished?" from "did the account
serve the session?" so a mid-stream failure re-pins the session. It had merged on the fork's
`main` but never reached this trunk; it composes with the fail-closed work above, so an
invalid tool call after the first byte both ends the stream with an error event and moves the
session. Fork PRs #3 and #4 (build-info, linked-install guard) were dropped — both sat on the
self-update code that no longer exists.

The fail-closed behaviour changed a decision of ours. Unparseable tool arguments used to
degrade to `input: {}`; a response truncated mid-JSON then reached the client as a
well-formed tool call carrying arguments the model never produced. It now raises, and
`fae7b41` routes that to the existing degrade path, so the request is answered by Anthropic
instead. Upstream answers 502 there — having a second provider, this fork can do better.

## What this fork deliberately does not have

- **Telemetry.** Deleted, not defaulted off. It was enabled by default and had been
  reporting account counts and uptime to the upstream maintainer's Aptabase key hourly.
- **Self-update.** Deleted. There is no npm package to update from, and the mechanism had
  already caused two incidents by replacing a linked development checkout with a published
  build. With it gone, the `autoUpdate` config flag and the `CC_ROUTER_NO_AUTO_UPDATE`
  service pin that guarded it are gone too.

The package is `@unohee/cc-router` and marked `private`, so nothing reaches a registry by
accident. Install is `git clone` + `npm link`; upgrade is `git pull && npm run build`.

The MIT licence and its existing copyright line are unchanged. Upstream's history is still
in this tree and still theirs.

## Taking something from upstream later

```bash
git fetch upstream                    # VictorMinemu/CC-Router, fetch-only
git log --oneline 555980d..upstream/main
git cherry-pick -x <sha>              # -x records where it came from
```

A clean cherry-pick is not a correct one — `a9e004d` applied without conflict against a
field this tree had renamed, and broke the build. Typecheck and run the suite after each.
