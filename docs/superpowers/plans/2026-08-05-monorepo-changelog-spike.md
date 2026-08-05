# Monorepo Per-Package Changelog — Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate, empirically and without touching any real config or CI, whether
`@anolilab/multi-semantic-release` can drive independent per-package versioning in this pnpm
workspace — before writing a single line of the real per-package `.releaserc` configs, the
aggregate-changelog script, or the `release-image.yml` trigger change.

**Architecture:** This is a one-task spike plan, not the full feature. Per the design spec's
Decision 8, the tool's fit for this specific repo is unproven (two of three researched
alternatives had disqualifying maintenance/compatibility issues; the third is small and new) —
Task 1 installs it temporarily, runs it in `--dry-run` against this repo's real commit history,
records exactly what happens, then reverts every change so the repository is untouched except for
a findings report. **The rest of this feature (per-package configs, the shared preset module, the
aggregation script, the CI trigger change) is a separate plan, written only after this task's
findings are in hand** — the spec's own Decision 8 requires this, and writing that plan now would
mean guessing at values (the exact tag format for scoped packages, whether `workspace:*` parses
cleanly) that this task exists specifically to discover.

**Tech Stack:** `@anolilab/multi-semantic-release` (`^4.4.6`), `semantic-release` (already a root
devDependency at `25.0.8`, satisfies the peer requirement `>=24.2.9`).

## Global Constraints

- Nothing in this task may be left behind in the repository except a findings report — the
  temporary devDependency and the temporary `package.json` `workspaces` field (Step 2 below) are
  both reverted in Step 6, before the commit in Step 7.
- No real per-package `.releaserc` files, no changes to `.releaserc.json`, no changes to
  `release-image.yml` — this task only runs the tool in dry-run mode and observes it.
- The findings report must answer, with concrete evidence (pasted tool output, not paraphrase),
  every question listed in Step 5 — an ambiguous or hand-waved answer to any of them blocks
  writing the next plan correctly.

---

### Task 1: Dry-run `@anolilab/multi-semantic-release` against this repo and report findings

**Files:**

- Create: `docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-findings.md`
- Temporarily modify (reverted before commit): `package.json`, `pnpm-lock.yaml`

**Interfaces:**

- Produces: `docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-findings.md` — the next
  plan (per-package changelog implementation, written separately after this task) consumes this
  report's answers, especially the confirmed tag format and any `workspace:*` parsing issues, as
  its own Global Constraints.

- [ ] **Step 1: Record the starting state**

```bash
git status --short
git rev-parse HEAD
```

Confirm the working tree is clean before starting (no unrelated uncommitted changes) — this
task's Step 6 revert depends on being able to tell "everything this task touched" apart from
anything already present.

- [ ] **Step 2: Install the tool as a temporary devDependency**

```bash
pnpm add -D @anolilab/multi-semantic-release@^4.4.6
```

`semantic-release@25.0.8` is already a root devDependency (confirmed in `package.json`) —
satisfies this package's peer requirement (`>=24.2.9`). Confirmed via the package's own README:
it does not support a zero-install `pnpm dlx`-style invocation; it expects to be installed and
run via its registered bin (`multi-semantic-release`).

- [ ] **Step 3: Add the `workspaces` field MSR requires**

The package's README states it needs an npm/yarn-style `"workspaces"` field in root
`package.json`, in addition to `pnpm-workspace.yaml` — pnpm itself ignores this field (it's
purely for MSR's own package discovery). In `package.json`, find the top-level `"name"` field
(near the start of the file) and add `"workspaces"` as a sibling key, matching
`pnpm-workspace.yaml`'s `packages` list exactly:

```json
"workspaces": ["apps/*", "packages/*", "configs/*"],
```

Run `pnpm install` after this edit is in place (no dependency changes expected — this is just to
confirm the field's presence doesn't break anything pnpm-side, since pnpm does validate the
`package.json` it reads even for fields it doesn't act on).

- [ ] **Step 4: Run the dry run**

```bash
pnpm exec multi-semantic-release --dry-run 2>&1 | tee /tmp/msr-dry-run-output.txt
echo "Exit code: $?"
```

Capture the FULL output (stdout and stderr both, via the `2>&1` above) — do not summarize or
truncate when copying it into the findings report in Step 5. If the command errors out entirely
before producing any per-package analysis, that is itself a critical finding — capture the full
error, including any stack trace.

- [ ] **Step 5: Write the findings report**

Create `docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-findings.md`. It must answer
each of these questions explicitly, quoting the relevant lines from `/tmp/msr-dry-run-output.txt`
as evidence for each answer — an answer without a quoted excerpt is not acceptable for this
report:

1. **Did the command complete, or crash?** If it crashed, what was the exact error, and does the
   error message point at `workspace:*` parsing, the `workspaces` field, missing config, or
   something else?
2. **If it completed: what tag format did it compute for a scoped package** (e.g.
   `@ruguin/core-server`)? Quote the exact string MSR says it would tag — this is the value the
   next plan's CI trigger change and per-package `tagFormat` config both depend on. If MSR only
   *logs* a planned action without concretely spelling out the tag string, say so explicitly
   rather than inferring one.
3. **Did every one of the 12 workspaces** (`apps/core-server`, `apps/dispatch-worker`,
   `packages/cache`, `packages/ddd-kernel`, `packages/env`, `packages/event-schemas`,
   `packages/message-broker`, `packages/shared-domain`, `packages/utils`,
   `configs/eslint-config`, `configs/prettier-config`, `configs/typescript-config`) **get
   analyzed**, or did any get silently skipped? List any that are missing from the output and
   quote the surrounding context if there's a stated reason.
4. **Did a change in a dependency package (e.g. `packages/env`) show up as propagating a bump to
   a workspace that depends on it** (e.g. `apps/core-server`, which lists `@ruguin/env` as a
   `workspace:*` dependency)? Quote the relevant output lines either way.
5. **Any warnings or errors specifically mentioning `workspace:*`** in the output — even
   non-fatal ones? Quote them verbatim if present, or state "no `workspace:*`-related output
   found" if a full-text search of the captured output turns up nothing.
6. **Overall verdict:** based on 1-5, is this tool viable for this repo's real per-package
   changelog implementation, viable with caveats (name them), or not viable (name why, and note
   this blocks the rest of the feature until reconsidered)?

- [ ] **Step 6: Revert everything except the findings report**

```bash
git diff --stat package.json pnpm-lock.yaml
git checkout -- package.json pnpm-lock.yaml
pnpm install
git status --short
```

Expected: the final `git status --short` shows only the new, untracked findings report file —
`package.json` and `pnpm-lock.yaml` are back to their committed state, and `node_modules` no
longer has `@anolilab/multi-semantic-release` (implied by `pnpm install` re-syncing against the
reverted lockfile).

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-findings.md
git commit -m "docs: record @anolilab/multi-semantic-release dry-run spike findings

Installed and reverted a temporary devDependency + package.json
workspaces field to run a real --dry-run against this repo's 12
workspaces. No config, CI, or dependency changes land from this task —
only the findings report."
```

## Self-Review Notes

- **Spec coverage:** this plan covers only the spec's Decision 8 (spike-first). The spec's
  Decisions 1-7 and 9 (tool config, shared preset module, aggregation script, CI trigger change,
  no-publish) are deliberately NOT covered here — they depend on this task's findings and belong
  in a second plan, written after this one completes. This is not a gap; it's the scope this
  spec's own Decision 8 calls for.
- **No placeholders:** every step has a real, runnable command. The one place this plan cannot
  give a fixed "expected output" (Step 4/5) is inherent to what a spike is — the report's
  structure (6 specific, evidence-required questions) is the mechanism that keeps this rigorous
  despite the outcome being genuinely unknown in advance.
- **Type/interface consistency:** N/A — this is a single-task infrastructure/tooling spike, no
  code interfaces are introduced.
