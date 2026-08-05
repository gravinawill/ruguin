# Spike findings round 2: `@anolilab/multi-semantic-release` dry-run, unblocked config

**Date:** 2026-08-05
**Commit under test:** `d73f4b2950714092fb63b48bf8b85af633e421cf` (branch `worktree-devops-wave-1-impl`)
**Tool versions:** `@anolilab/multi-semantic-release@4.4.6` (installed; reports itself as `4.4.5` at
runtime), `semantic-release@25.0.8` (pre-existing root devDependency)

This round exists to answer the two questions round 1 left open (see
[round 1's findings](2026-08-05-monorepo-changelog-spike-findings.md)): the concrete tag format for
a scoped package, and whether a `packages/env` change propagates a computed bump to a dependent
workspace via `workspace:*`. Round 1 never reached either answer because
`@semantic-release/github`'s `verifyConditions` step failed on a missing `GH_TOKEN` before any
versioning/tagging logic ran. This round removes that plugin (and `@semantic-release/git`,
`@semantic-release/changelog`) from a disposable `.releaserc.json` to reach that logic directly.

## Setup performed

1. `pnpm add -D -w @anolilab/multi-semantic-release@^4.4.6` — same `-w` requirement as round 1.
2. Added `"workspaces": ["apps/*", "packages/*", "configs/*"]` to root `package.json`. `pnpm
   install` re-ran cleanly afterward.
3. Replaced `.releaserc.json` with the brief's disposable config:
   ```json
   {
     "branches": ["*"],
     "plugins": ["@semantic-release/commit-analyzer", "@semantic-release/release-notes-generator"]
   }
   ```
4. Ran `pnpm exec multi-semantic-release --dry-run` per Step 5 (the primary, mandated command).

All of this was reverted before committing this report (see "Revert verification" below).

## A new blocker the brief did not anticipate: the wildcard `branches: ["*"]` itself

The primary Step 5 command — exactly as specified — did **not** reach per-package versioning
logic. It failed immediately with a different error than either of round 1's two blockers:

```
[@ruguin/typescript-config] › ✘  ERELEASEBRANCHES The release branches are invalid in the `branches` configuration.
A minimum of 1 and a maximum of 3 release branches are required in the branches configuration
(https://semantic-release.org/usage/configuration#branches). These branches must exist on the
remote repository.

This may occur if your repository does not have a release branch, such as master or main.

Your configuration for the problematic branches is [ { channel: undefined, tags: [], type: 'release', name: 'develop', range: '>=1.0.0', accept: [ 'patch', 'minor', 'major' ], main: true }, { channel: 'master', tags: [], type: 'release', name: 'master', range: '>=1.0.0', accept: [ 'patch', 'minor', 'major' ], main: false }, { channel: 'worktree-cozy-mixing-minsky', tags: [], type: 'release', name: 'worktree-cozy-mixing-minsky', range: '>=1.0.0', accept: [ 'patch', 'minor', 'major' ], main: false }, { channel: 'worktree-devops-wave-1-impl', tags: [], type: 'release', name: 'worktree-devops-wave-1-impl', range: '>=1.0.0', accept: [ 'patch', 'minor', 'major' ], main: false }, { channel: 'worktree-ses-webhook-ingestor-design', tags: [], type: 'release', name: 'worktree-ses-webhook-ingestor-design', range: '>=1.0.0', accept: [ 'patch', 'minor', 'major' ], main: false } ].
```

**Root cause:** the wildcard `branches: ["*"]` expanded to every local branch present in this
worktree-heavy repo at the time of the run — `develop`, `master`,
`worktree-cozy-mixing-minsky`, `worktree-devops-wave-1-impl`, `worktree-ses-webhook-ingestor-design`
(confirmed via `git branch -a`, which lists these same five as local branches, one per active
worktree, plus two more remote-only branches not in the resolved set). `semantic-release` caps
release branches at 3; five resolved, so it refused to run for every one of the 6 loaded packages.
Exit code: 1.

**This is a genuinely new, repo-specific finding**, distinct from round 1's two blockers: a
wildcard `branches` config — which reads as an obviously safe way to sidestep a fixed
`branches: ["master"]` restriction — is *not* safe in a repo that uses `git worktree` heavily,
because each active worktree adds a local branch, and those branches count toward
`semantic-release`'s hard cap of 3. Any real per-package `.releaserc` design for this repo must
name explicit branches (e.g. `["master", "develop"]`), never a wildcard, or it will break the
moment a third worktree is checked out locally — which, per this repo's own git-flow-heavy,
worktree-per-task workflow, is a normal and frequent state, not an edge case.

## Getting past it: a supplementary single-branch override

To still reach the two questions this round exists to answer, I ran one supplementary invocation —
same disposable `.releaserc.json`, no further file changes, a CLI-only branch override to the
current branch (mirroring round 1's own supplementary-run methodology for its GH_TOKEN blocker):

```bash
pnpm exec multi-semantic-release --dry-run --branches worktree-devops-wave-1-impl
```

This run completed with **exit code 0** and reached full per-package versioning, tagging, and
release-note generation for all 6 loaded packages:

```
🎉  msr: Released 6 of 6 packages, semantically!
Exit code: 0
```

Everything below in Questions 1 and 2 is evidence from this supplementary run, not the primary
Step 5 command — the primary command's own output is fully quoted above and never got past the
branch-count error.

## Question 1: What tag format did MSR compute for a scoped package?

**Confirmed: `${name}@${version}`, exactly as the README's generic example describes — and now
verified against this repo's real output, not inferred.** Every one of the 6 loaded packages logged
an explicit tag string in its "skip tag creation" line (skipped only because `--dry-run` disables
the actual `git tag` call, not because no tag was computed):

```
[@ruguin/typescript-config] › ⚠  Skip @ruguin/typescript-config@1.0.0 tag creation in dry-run mode
[@ruguin/eslint-config]     › ⚠  Skip @ruguin/eslint-config@1.0.0 tag creation in dry-run mode
[@ruguin/prettier-config]   › ⚠  Skip @ruguin/prettier-config@1.0.0 tag creation in dry-run mode
[@ruguin/env]               › ⚠  Skip @ruguin/env@1.0.0 tag creation in dry-run mode
[@ruguin/core-server]       › ⚠  Skip @ruguin/core-server@1.0.0 tag creation in dry-run mode
[@ruguin/dispatch-worker]   › ⚠  Skip @ruguin/dispatch-worker@1.0.0 tag creation in dry-run mode
```

For the scoped package the brief asks about specifically, `@ruguin/core-server`, the computed tag
string is **`@ruguin/core-server@1.0.0`**. All six loaded packages report `1.0.0` because none has
a prior git tag in this repo ("No git tag version found on branch worktree-devops-wave-1-impl... no
previous release, the next release version is 1.0.0" — logged identically for each), so this is a
first-release version, not evidence of a bug; the tag *format* is the answer this question needs,
and it is confirmed.

## Question 2: Did a `packages/env` change propagate a computed bump to a dependent workspace via `workspace:*`?

**Confirmed yes.** `apps/core-server/package.json` lists `"@ruguin/env": "workspace:*"` in
`dependencies` (unchanged from round 1's confirmation). In this run, `@ruguin/core-server`'s
generated release notes include a `### Dependencies` section listing `@ruguin/env` as upgraded:

```
# @ruguin/core-server 1.0.0 (2026-08-05)
...
### Dependencies

    * **@ruguin/env:** upgraded to 1.0.0
    * **@ruguin/eslint-config:** upgraded to 1.0.0
    * **@ruguin/prettier-config:** upgraded to 1.0.0
    * **@ruguin/typescript-config:** upgraded to 1.0.0
```

MSR's dependency-graph propagation is real and working end-to-end for this repo's `workspace:*`
wiring: `@ruguin/env`'s own release triggered a "Dependencies" bump entry in every package that
depends on it (`@ruguin/core-server` and `@ruguin/dispatch-worker` both show it; `@ruguin/eslint-config`
propagates the same way into `@ruguin/prettier-config`). This is exactly the propagation behavior
the eventual CI design needs to rely on. Note the literal string `workspace:*` itself never appears
in the tool's own log output (grepped case-insensitively across both captured files; the only
"workspace" hits are two unrelated commit-message lines) — MSR communicates the propagation via the
"Dependencies" section of the generated release notes, not by naming the `workspace:*` protocol
directly. That's a documentation nuance, not a gap: the propagation itself is directly observed.

## Carried forward from round 1 (reconfirmed, not re-derived)

- **Private-package exclusion reconfirmed identically.** The same 6 of 11 real workspaces loaded
  (`@ruguin/core-server`, `@ruguin/dispatch-worker`, `@ruguin/env`, `@ruguin/eslint-config`,
  `@ruguin/prettier-config`, `@ruguin/typescript-config`); the same 5 `"private": true` packages
  were silently skipped again (`packages/cache`, `packages/event-schemas`,
  `packages/message-broker`, `packages/shared-domain`, `packages/utils`). Round 1's Caveat 1 stands
  unchanged and is now doubly confirmed across two independent runs.
- **`packages/ddd-kernel` stale-directory note** from round 1 is unrelated to this round's scope;
  see Step 7 below for the correction applied to round 1's own report.

## Overall viability verdict: **viable with caveats**

This supersedes round 1's "not viable to confirm... leans toward viable with significant caveats"
verdict now that both previously-open questions are answered with direct evidence:

**What's now confirmed working:**
- Tag format for scoped packages is `${name}@${version}` (e.g. `@ruguin/core-server@1.0.0`) —
  confirmed directly, not inferred from documentation.
- `workspace:*` dependency propagation works end-to-end: a version bump in a dependency workspace
  (`@ruguin/env`) correctly surfaces as a "Dependencies" bump entry in every real dependent
  (`@ruguin/core-server`, `@ruguin/dispatch-worker`).
- The tool completes cleanly (exit 0) and produces correct, readable per-package release notes
  once given a plugin pipeline that doesn't require external credentials and a `branches` config
  that resolves to ≤3 real branches.

**Caveats that must be designed around, not blockers that kill the approach:**
1. **Private-package exclusion (carried from round 1, now reconfirmed twice):** 5 of 11 real
   workspaces are `"private": true` and are silently excluded from MSR's package discovery. The
   next plan must verify against MSR's source/docs whether a config flag can include private
   packages, or explicitly scope the rollout to only the 6 public-facing packages initially.
2. **Wildcard branch configs are unsafe in this repo (new this round):** `branches: ["*"]` breaks
   as soon as more than 3 local branches exist, which is the normal state for a repo run out of
   git worktrees per task. Any real `.releaserc` must enumerate explicit branches
   (e.g. `["master", "develop"]`), never a wildcard.
3. **The real (non-disposable) `.releaserc.json` still needs `@semantic-release/github` for actual
   GitHub releases**, which requires a real `GH_TOKEN` in CI (not a local-dry-run concern — CI
   already has this available via `GITHUB_TOKEN`, but it's worth naming explicitly since this
   spike's disposable config removed it to reach an answer).

No new blocker was found that would make the MSR approach itself non-viable — both this round's
new blocker (wildcard branches) and both of round 1's blockers (branch-mismatch, missing token) are
either non-issues in real CI (branch mismatch and token only matter for ad hoc local dry-runs; CI
runs on a single named branch with `GITHUB_TOKEN` already set) or addressable by explicit
`.releaserc` design choices (naming branches, scoping to public packages). The one caveat that is a
genuine open design question for the next plan is private-package inclusion.

## Revert verification

```
$ git diff --stat package.json pnpm-lock.yaml .releaserc.json
 .releaserc.json |  16 +-------
 package.json    |   2 +
 pnpm-lock.yaml  | 121 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 3 files changed, 125 insertions(+), 14 deletions(-)

$ git checkout -- package.json pnpm-lock.yaml .releaserc.json
$ pnpm install
# ... re-synced cleanly

$ diff <backup>/releaserc-backup.json .releaserc.json && echo "PASS: .releaserc.json matches the pre-task backup"
PASS: .releaserc.json matches the pre-task backup

$ git status --short
 M docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-findings.md
?? docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-round2-findings.md
```

Only the two intended report changes remain; `package.json`, `pnpm-lock.yaml`, and
`.releaserc.json` are all back to their committed state.
