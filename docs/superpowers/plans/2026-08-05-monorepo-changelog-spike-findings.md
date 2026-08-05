# Spike findings: `@anolilab/multi-semantic-release` dry-run against `ruguin`

**Date:** 2026-08-05
**Commit under test:** `bd5f1102e4b611c54ce1b8e8a71b4eddf77a2859` (branch `worktree-devops-wave-1-impl`)
**Tool versions:** `@anolilab/multi-semantic-release@4.4.6` (installed; reports itself as `4.4.5` at
runtime), `semantic-release@25.0.8` (pre-existing root devDependency)

## Setup performed

1. `pnpm add -D -w @anolilab/multi-semantic-release@^4.4.6` — required `-w` since pnpm refuses a
   bare root add without it (`ERR_PNPM_ADDING_TO_ROOT`).
2. Added `"workspaces": ["apps/*", "packages/*", "configs/*"]` to root `package.json`, matching
   `pnpm-workspace.yaml`'s `packages` list. `pnpm install` re-ran cleanly afterward — the field is
   inert to pnpm but didn't break validation.
3. Ran `pnpm exec multi-semantic-release --dry-run` per Step 4, capturing full stdout+stderr.

All of this was reverted before committing this report (see "Revert verification" below).

## Question 1: Did the command complete, or crash?

**Completed — exit code 0.** No crash, no stack trace, on the exact command specified in Step 4.

```
[7:30:23 AM] › 🎉  msr: Released 0 of 6 packages, semantically!
Exit code: 0
```

However, "completed cleanly" is misleading on its own — see Questions 2 and 3. The run stopped
early for every package it did load, before reaching any versioning or tagging logic, because of
a branch-config mismatch:

```
[7:30:12 AM] [@ruguin/typescript-config] › ℹ  This test run was triggered on the branch worktree-devops-wave-1-impl, while semantic-release is configured to only publish from master, therefore a new version won't be published.
```

This is not an MSR bug — it's `.releaserc.json`'s `"branches": ["master"]` doing exactly what it's
configured to do, applied per-package by MSR. It means the primary captured run (the one Step 4
mandates) never got far enough to answer Questions 2 and 4 on its own. To get past this gate for a
supplementary look, I re-ran with a CLI-only override (no file changes): `multi-semantic-release
--dry-run --branches worktree-devops-wave-1-impl`. That run got one step further, then failed at
the `@semantic-release/github` plugin's `verifyConditions` step because no `GH_TOKEN` is set in
this environment:

```
[7:33:01 AM] [@ruguin/typescript-config] › ✘  ENOGHTOKEN No GitHub token specified.
```

I also tried supplying a dummy `GH_TOKEN` value to get past that gate too; MSR/semantic-release
correctly rejected it after a live GitHub API check:

```
[7:33:32 AM] [@ruguin/typescript-config] › ✘  EINVALIDGHTOKEN Invalid GitHub token.
```

I did not go further with a real token — that's out of scope for a local spike and would require
real credentials. **Net result: with only the exact Step 4 command, and even with a branch
override, this repo's dry run never reaches the point where MSR computes or logs an actual version
bump or tag string**, because `@semantic-release/github` is wired into the plugin pipeline and its
`verifyConditions` step runs (and fails without a valid token) before the versioning/tagging steps
that would run later in the pipeline.

## Question 2: What tag format did it compute for a scoped package?

**Not determined — the tool never logged a concrete tag string in any of the three runs performed
(primary Step-4 command, branch-override supplement, dummy-token supplement).** The primary run
stopped at the branch check (Question 1) before reaching tag computation. The branch-override runs
got one step further but failed at GitHub token verification, which happens earlier in the
semantic-release plugin pipeline than versioning/tagging. No line in any captured output contains
the words "tag" (case-insensitive full-text search across all three output files returned zero
matches).

This means **the confirmed tag format the next plan needs is still unconfirmed by this spike.**
Getting it would require either running with a real `GH_TOKEN` (out of scope here) or removing the
`@semantic-release/github` plugin from a throwaway test config to isolate the versioning/tagging
plugins from the GitHub-publishing plugins — neither of which Step 4 as written asked for.

## Question 3: Did every one of the 11 workspaces (the brief's original count of 12 double-counted `packages/ddd-kernel`, renamed to `packages/shared-domain` in commit `98a7d0e` and no longer a real package — corrected here) get analyzed?

**No — only 6 of the packages that actually exist were analyzed, and the "12" premise itself is
partly stale.**

First, a correction to the workspace list assumed by this task's brief: `packages/ddd-kernel` no
longer has a `package.json` — it was renamed to `packages/shared-domain` in commit `98a7d0e`
("refactor: rename @ruguin/ddd-kernel to @ruguin/shared-domain"). The `packages/ddd-kernel`
directory still exists on disk but contains only stale build artifacts (`dist`, `coverage`,
`node_modules`, `.turbo` — confirmed via `ls -la`), no `package.json`. So the real current
workspace count is **11**, not 12: `apps/core-server`, `apps/dispatch-worker`, `packages/cache`,
`packages/env`, `packages/event-schemas`, `packages/message-broker`, `packages/shared-domain`,
`packages/utils`, `configs/eslint-config`, `configs/prettier-config`, `configs/typescript-config`.

Of those 11, MSR loaded only 6:

```
[7:30:10 AM] › 🎉  msr: Started multirelease! Loading 6 packages...
[7:30:10 AM] › ✔  msr: Loaded package @ruguin/core-server
[7:30:10 AM] › ✔  msr: Loaded package @ruguin/dispatch-worker
[7:30:10 AM] › ✔  msr: Loaded package @ruguin/env
[7:30:10 AM] › ✔  msr: Loaded package @ruguin/eslint-config
[7:30:10 AM] › ✔  msr: Loaded package @ruguin/prettier-config
[7:30:10 AM] › ✔  msr: Loaded package @ruguin/typescript-config
[7:30:10 AM] › 🎉  msr: Queued 6 packages! Starting release...
```

**5 real workspaces were silently skipped**, with zero log line anywhere in the output naming them
or explaining why: `packages/cache`, `packages/event-schemas`, `packages/message-broker`,
`packages/shared-domain`, `packages/utils`. I cross-checked each skipped package's `package.json`
against the 6 that loaded, and found a perfect correlation: **every skipped package has
`"private": true`; none of the 6 loaded packages do** (confirmed via `pnpm -r list --depth -1`,
which marks the same 5 packages `(PRIVATE)`). This strongly suggests MSR's default package
discovery filters out `"private": true` workspaces — but the tool itself never states this in the
dry-run output; it's an inference from correlation, not something MSR told me. If this inference
is correct, it's a significant compatibility issue for this repo, since 5 of 11 workspaces (all of
`packages/` except `env`) are marked private and would silently never get a changelog or release
under MSR's defaults.

## Question 4: Did a dependency-package change propagate a bump to a dependent workspace?

**Cannot be determined from this spike's output — no evidence either way.** `apps/core-server`
does list `@ruguin/env` as a `workspace:*` dependency (confirmed: `"@ruguin/env": "workspace:*"` in
`apps/core-server/package.json`), so the scenario the question asks about is real in this repo.
But the primary dry run stopped at the per-package branch check before any commit-analysis or
dependency-graph-propagation logic could run for any package, `@ruguin/env` included — so there is
no propagation-related output to quote, positive or negative. No line in any of the three captured
outputs mentions dependency propagation, bump inheritance, or `@ruguin/env` being a trigger for
`@ruguin/core-server`.

## Question 5: Any warnings or errors mentioning `workspace:*`?

**No `workspace:*`-related output found.** Full-text case-insensitive search for `workspace` across
all three captured output files (primary Step-4 run, branch-override run, dummy-token run) returned
zero matches in every file. Nothing in the output ever mentions the `workspace:*` protocol,
positively or negatively.

## Question 6: Overall verdict

**Not viable to confirm with this spike as run — needs a follow-up spike before committing to a
plan, and the current finding leans toward "viable with significant caveats," but that lean is
unconfirmed on the two questions (tag format, dependency propagation) the next plan most needs
answered.**

What this spike *did* confirm:

- The tool installs, runs, and doesn't crash outright against this repo's structure (`workspaces`
  field + `pnpm-workspace.yaml` coexist fine).
- **Caveat 1 (likely blocking as-is):** MSR appears to silently exclude `"private": true`
  workspaces from analysis entirely — 5 of this repo's 11 real packages. If confirmed, per-package
  changelogs would silently not happen for most of `packages/`, which contradicts the goal of a
  monorepo-wide per-package changelog. This needs to be verified against MSR's actual source/docs
  (not just inferred from one dry run) before the next plan assumes MSR will cover the full
  workspace set — possibly via an MSR config option to include private packages, if one exists.
- **Caveat 2 (blocks answering the two load-bearing questions):** this repo's `.releaserc.json`
  wires `@semantic-release/github` into the plugin pipeline, and `verifyConditions` for that plugin
  runs — and fails without a valid `GH_TOKEN` — before any versioning/tagging logic executes. A
  fully informative local dry run (one that reaches tag-format computation and dependency
  propagation) requires either a real GitHub token or a throwaway release config with the GitHub
  plugin stripped out, restricted to just the versioning-relevant plugins
  (`commit-analyzer`, `release-notes-generator`). Neither was in scope for this task's fixed Step 4
  command.
- The stale `packages/ddd-kernel` directory (build artifacts with no `package.json`, superseded by
  `packages/shared-domain`) is unrelated repo cleanliness cruft, not an MSR finding, but worth a
  separate cleanup ticket — `git clean` was intentionally not run here since Step 6 required only
  reverting the two tracked files this task touched.

**Recommendation for the next plan:** before designing the per-package `tagFormat` config or CI
trigger change, run one more narrowly-scoped follow-up (not a full plan) that either (a) supplies a
real `GH_TOKEN` in a safe sandboxed context, or (b) runs MSR against a temporary `.releaserc.json`
with only `commit-analyzer` + `release-notes-generator` configured, to get a concrete answer on the
tag string and propagation behavior — and separately, check MSR's documentation/source for a config
flag governing `private: true` package inclusion, since that is the more repo-structural risk of
the two.

## Revert verification

```
$ git diff --stat package.json pnpm-lock.yaml
 package.json   |   2 +
 pnpm-lock.yaml | 121 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 123 insertions(+)

$ git checkout -- package.json pnpm-lock.yaml
$ pnpm install
# ... re-synced cleanly, @anolilab/multi-semantic-release removed from node_modules

$ git status --short
?? docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-findings.md
```

Only this findings report remains untracked; `package.json` and `pnpm-lock.yaml` are back to their
committed state.
