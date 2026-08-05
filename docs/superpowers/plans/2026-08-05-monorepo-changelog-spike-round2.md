# Monorepo Per-Package Changelog — Spike Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get `@anolilab/multi-semantic-release` past the two blockers that stopped
[round 1](2026-08-05-monorepo-changelog-spike.md) from reaching its own versioning logic
(`.releaserc.json`'s `branches: ["master"]` restriction, and `@semantic-release/github`'s
`GH_TOKEN` requirement) — using a temporary, disposable release config, so this round can finally
answer the two questions round 1 couldn't: the tag format for scoped packages, and whether a
change in one workspace propagates a bump to workspaces that depend on it via `workspace:*`.

**Architecture:** Single-task plan, same discipline as round 1: install nothing permanent, swap
`.releaserc.json` for a minimal, analysis-only config for the duration of one dry run, restore the
original file, commit only a findings report.

**Tech Stack:** Same as round 1 — `@anolilab/multi-semantic-release` (`^4.4.6`),
`semantic-release` (already a root devDependency).

## Global Constraints

- Nothing in this task may be left behind except the findings report and one correction to round
  1's findings doc (the workspace count) — `.releaserc.json`, `package.json`, and
  `pnpm-lock.yaml` are all restored to their exact committed state before the final commit, same
  discipline as round 1.
- Round 1 confirmed the real workspace count is **11**, not 12 —
  `packages/ddd-kernel` was renamed to `packages/shared-domain` in commit `98a7d0e` and no
  longer has a `package.json`; round 1's own brief double-counted it. This plan's task uses 11
  throughout — do not reintroduce the stale count.
- The temporary `.releaserc.json` used for this dry run strips `@semantic-release/github`,
  `@semantic-release/git`, and `@semantic-release/changelog` — none of the three are needed to
  answer this round's two questions (tag format, dependency-bump propagation), and removing them
  eliminates the `GH_TOKEN` requirement and any real git-write attempt.
- The temporary `.releaserc.json` sets `"branches": ["*"]` — a wildcard, not the current
  worktree's specific branch name, so this task (and any future re-run of it) isn't tied to a
  branch name that won't exist later.

---

### Task 1: Re-run the dry run with a disposable, unblocked release config

**Files:**

- Create: `docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-round2-findings.md`
- Temporarily modify (reverted before commit): `.releaserc.json`, `package.json`,
  `pnpm-lock.yaml`
- Modify: `docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-findings.md` (correct the
  workspace count from round 1's report, per the Global Constraints note above — round 1's report
  already states the correct count of 11 in its body text, but its own title/summary line still
  says "12 workspaces (round 1 brief's count)"; grep the file for "12" and fix any remaining
  stale reference)

**Interfaces:**

- Consumes: round 1's findings doc
  (`docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-findings.md`) — read it first for
  what's already known (private packages likely excluded, `workspace:*` never errors) so this
  round doesn't re-derive it.
- Produces: `docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-round2-findings.md` — the
  eventual real implementation plan (per-package `.releaserc` configs, the CI trigger change)
  consumes both rounds' findings docs as its Global Constraints.

- [ ] **Step 1: Record the starting state**

```bash
git status --short
git rev-parse HEAD
cp .releaserc.json /tmp/releaserc-backup.json
```

Confirm the working tree is clean before starting, same reasoning as round 1's Step 1 — this
task's revert step depends on being able to tell "everything this task touched" apart from
anything already present. The `cp` is a safety net in addition to `git checkout` in Step 6.

- [ ] **Step 2: Install the tool as a temporary devDependency**

```bash
pnpm add -D @anolilab/multi-semantic-release@^4.4.6
```

Same as round 1 — `semantic-release@25.0.8` (already a root devDependency) satisfies the peer
requirement (`>=24.2.9`).

- [ ] **Step 3: Add the `workspaces` field MSR requires**

In `package.json`, find the top-level `"name"` field (near the start of the file) and add
`"workspaces"` as a sibling key:

```json
"workspaces": ["apps/*", "packages/*", "configs/*"],
```

Run `pnpm install` after this edit — same as round 1, confirming the field's presence doesn't
break anything pnpm-side.

- [ ] **Step 4: Replace `.releaserc.json` with a minimal, unblocked config**

Replace the entire contents of `.releaserc.json` with:

```json
{
  "branches": ["*"],
  "plugins": ["@semantic-release/commit-analyzer", "@semantic-release/release-notes-generator"]
}
```

This removes the `branches: ["master"]` restriction that stopped round 1 before it reached any
package's versioning logic, and removes `@semantic-release/github` (the plugin whose
`verifyConditions` step demanded a real `GH_TOKEN` in round 1) along with `@semantic-release/git`
and `@semantic-release/changelog` (neither needed to answer this round's two questions — keeping
the plugin list minimal reduces the chance of hitting a third, unrelated blocker).

- [ ] **Step 5: Run the dry run**

```bash
pnpm exec multi-semantic-release --dry-run 2>&1 | tee /tmp/msr-round2-dry-run-output.txt
echo "Exit code: $?"
```

Capture the full output, same discipline as round 1's Step 4 — do not summarize or truncate when
copying it into the findings report in Step 6. If this run hits a NEW blocker neither round 1 nor
this plan anticipated, that is itself a critical finding for the report — capture the full error.

- [ ] **Step 6: Write the round 2 findings report**

Create `docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-round2-findings.md`. It must
answer these two questions explicitly, quoting the relevant lines from
`/tmp/msr-round2-dry-run-output.txt` as evidence — an answer without a quoted excerpt is not
acceptable:

1. **What tag format did MSR compute for a scoped package** (e.g. `@ruguin/core-server` or
   `@ruguin/cache`, whichever workspace the tool's output actually shows a computed next-version
   or tag string for)? Quote the exact string. If the output still doesn't spell out a concrete
   tag string even after reaching real per-package analysis, say so explicitly and quote whatever
   related output exists (e.g. a computed version number without an accompanying tag string) —
   don't infer a tag format from the README's generic `${name}@${version}` example if the actual
   run output doesn't confirm it applies here.
2. **Did a change in `packages/env` (or any other dependency workspace with real commit history
   touching it) show up as propagating a computed bump to a workspace that depends on it via
   `workspace:*`** (e.g. `apps/core-server`, which lists `@ruguin/env` in its
   `package.json`'s `dependencies`)? Quote the relevant output lines either way. If this run
   still doesn't reach enough of the analysis to answer this, say so and quote the point where it
   stopped.

Also carry forward, with a one-line reference (not a full re-derivation), anything round 1 already
established that this run reconfirms or contradicts — e.g. if the same 5 private packages are
skipped again, a single sentence noting the reconfirmation is enough; if this run's coverage
differs from round 1's, that discrepancy itself needs a full explanation with evidence.

Close the report with an updated overall viability verdict: **viable**, **viable with caveats**
(name them), or **not viable** (name why) — this supersedes round 1's "viable with caveats"
verdict now that the two previously-open questions are addressed one way or the other.

- [ ] **Step 7: Fix the stale workspace count in round 1's findings doc**

```bash
grep -n "12 workspace" docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-findings.md
```

If this returns any matches, edit each one: replace "12 workspaces" with "11 workspaces (the
brief's original count of 12 double-counted `packages/ddd-kernel`, renamed to
`packages/shared-domain` in commit `98a7d0e` and no longer a real package — corrected here)".
Read the file first to find the exact surrounding text before editing, per this repo's own rule
of reading before editing.

- [ ] **Step 8: Revert everything except the two report changes**

```bash
git diff --stat package.json pnpm-lock.yaml .releaserc.json
git checkout -- package.json pnpm-lock.yaml .releaserc.json
pnpm install
diff /tmp/releaserc-backup.json .releaserc.json && echo "PASS: .releaserc.json matches the pre-task backup"
git status --short
rm /tmp/releaserc-backup.json /tmp/msr-round2-dry-run-output.txt
```

Expected: the `diff` line prints nothing (files identical) followed by the `PASS` echo, and the
final `git status --short` shows only the new round 2 findings report and the corrected round 1
findings doc — `package.json`, `pnpm-lock.yaml`, and `.releaserc.json` are all back to their
committed state.

- [ ] **Step 9: Commit**

```bash
git add docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-round2-findings.md \
  docs/superpowers/plans/2026-08-05-monorepo-changelog-spike-findings.md
git commit -m "docs: record spike round 2 findings (tag format, bump propagation)

Temporarily swapped .releaserc.json for a minimal, unblocked config
(wildcard branches, no @semantic-release/github/git/changelog) to get
multi-semantic-release past the two blockers that stopped round 1
before reaching per-package versioning logic. Also corrects round 1's
findings doc: 11 real workspaces, not 12 (packages/ddd-kernel no
longer exists, renamed to packages/shared-domain)."
```

## Self-Review Notes

- **Spec coverage:** this task exists solely to close the two gaps round 1 left open in the
  design spec's Decision 8 — it does not implement any of Decisions 1-7/9, same reasoning as
  round 1's own Self-Review Notes.
- **No placeholders:** every step has a real, runnable command, including the exact
  `.releaserc.json` replacement content (no "TBD" plugin list). Same as round 1, Steps 5-6's
  actual dry-run OUTPUT cannot be fixed in advance — that's what a spike is — but the two
  questions Step 6 must answer are specific and evidence-gated, not open-ended.
- **Type/interface consistency:** N/A, single-task tooling spike, no code interfaces introduced.
