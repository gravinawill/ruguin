# Danger PR Hygiene Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four PR-hygiene checks to `dangerfile.ts` — source-without-test warning, large-PR warning, CODEOWNERS-based suggested-reviewers section, and automatic area labels — per `docs/superpowers/specs/2026-08-04-danger-pr-hygiene-checks-design.md`.

**Architecture:** All logic lives directly in `dangerfile.ts` (no new npm packages), following the exact structure already established by `coverageSection()`/`featuresSection()`/`endpointsSection()`/`gifSection()`. Each new check is a plain function; synchronous warn-only checks are called directly, section-producing checks feed the existing `sections` array, and the one async/API-calling check goes through `schedule()`. There are no unit tests for `dangerfile.ts` in this repo — verification is empirical, by running `danger local`/`danger pr` against a real diff and reading the actual output, matching how every prior Danger change in this repo was verified (see `docs/superpowers/plans/2026-08-04-danger-coderabbit-improvements.md`).

**Tech Stack:** `danger` 13.0.10 (already a devDependency), TypeScript (transpiled by Danger's own `ts.transpileModule`, not `tsc` — see the CJS/ESM interop comment already at the top of `dangerfile.ts`), Node's `node:fs`.

## Global Constraints

- Every new check uses `warn()`, never `fail()` — none of these may block a PR (per spec Decision 1, confirmed for all four checks).
- `LARGE_PR_LINE_THRESHOLD = 500` exactly (spec Decision 2).
- `.github/CODEOWNERS` content is exactly `* @gravinawill` (spec Decision 3) — single owner, confirmed with the user.
- `AREA_LABELS` prefix→label mapping is exactly the 6 entries in spec Decision 4 (verbatim below) — the 4 new labels (`terraform`, `kubernetes`, `core-server`, `dispatch-worker`) already exist on `gravinawill/ruguin` (confirmed via `gh label list`); `github_actions` and `documentation` are pre-existing labels being reused, not created.
- Use `danger.github.thisPR.pull_number` for the Octokit `issue_number` param, never the deprecated `danger.github.thisPR.number` (confirmed in `node_modules/danger/distribution/dsl/GitHubDSL.d.ts`: `number` carries `@deprecated use pull_number instead`).
- **Any code that reads `danger.github` (not `danger.git`) must guard against it being `undefined`.** `danger.github` is typed non-nullable but is genuinely `undefined` under `danger local` (no real PR context) — an unguarded synchronous read throws during module evaluation, which stops Danger's runner before it reaches `runAllScheduledTasks()`/`markdown()` and silently discards the *entire* PR report, not just the offending check. This exact bug was found and fixed for `gifSection()` in the prior wave (see the comment above `gifSection()` in the current `dangerfile.ts`) — do not reintroduce it. `danger.git` (used by the source/test check, the CODEOWNERS check, and the area-labels check) does not have this problem and needs no guard.
- No new npm dependencies. Everything is hand-rolled in `dangerfile.ts`, per spec Decisions 1 and 3 (the CODEOWNERS parser is intentionally simplified, not a full `.gitignore`-glob implementation).

---

## File Structure

- **Modify `dangerfile.ts`** — add all four checks' logic and wiring. No new files needed for the check logic itself.
- **Create `.github/CODEOWNERS`** — minimal single-owner file the suggested-reviewers check reads.

## Verification commands used across all tasks

- **Lint:** `pnpm exec eslint dangerfile.ts` — must report 0 problems.
- **Local diff test:** `pnpm exec danger local -s -b HEAD --text-only` — runs `dangerfile.ts` against whatever is currently staged, compared to `HEAD`. Only actually evaluates the file when there is a real staged diff — against a clean tree it short-circuits with "No git changes detected" and never runs the file at all, which is **not** valid verification. Always `git add` a real change before running this.
- **Real-PR test:** `DANGER_GITHUB_API_TOKEN=$(gh auth token) pnpm exec danger pr https://github.com/gravinawill/ruguin/pull/8 --text-only` — runs `dangerfile.ts` against the actual diff and `danger.github` context of PR #8 (the live accumulating PR this branch feeds). This is the only way to exercise anything that touches `danger.github` for real, since `danger local` never populates it.

---

### Task 1: Source-without-test warning and large-PR warning

**Files:**
- Modify: `dangerfile.ts`

**Interfaces:**
- Produces: `sourceWithoutTestWarning(): void`, `largePrWarning(): void`, `const LARGE_PR_LINE_THRESHOLD = 500` — none consumed by later tasks, but Task 2 and Task 3 add their own functions to the same file in the same region (right before the `noTestShortcuts({...})` call), so preserve the surrounding structure exactly as left by this task.

- [ ] **Step 1: Add the two check functions to `dangerfile.ts`**

Open `dangerfile.ts` and find this exact block (the end of `gifSection()`):

```ts
function gifSection(): string {
  /*
   * Optional chaining: danger.github is undefined under `danger local` (no real PR exists in
   * that mode) — reading .pr off it would throw synchronously during module evaluation, which
   * skips Danger's runAllScheduledTasks() entirely and silently breaks every schedule()-based
   * check in this file, not just this one.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- danger.github can be undefined at runtime (danger local mode) despite being typed as non-null
  const body = danger.github?.pr?.body
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, sonarjs/different-types-comparison -- body's static type is always `string` because danger.github is (wrongly) typed non-null, but it's genuinely `undefined` at runtime under `danger local`
  if (body === undefined) return ''
  return body.includes('.gif') ? '' : '⚠️ Essa PR não tem gif na descrição. Considere adicionar um.'
}
```

Immediately after this block (before the `noTestShortcuts({...})` call), insert:

```ts
function sourceWithoutTestWarning(): void {
  const changedFiles = [...danger.git.modified_files, ...danger.git.created_files]
  const sourceFiles = changedFiles.filter(
    (file) => /\/(application|domain)\//.test(file) && !file.includes('/__tests__/')
  )

  const withoutTest = sourceFiles.filter((sourceFile) => {
    const lastSlash = sourceFile.lastIndexOf('/')
    const directory = sourceFile.slice(0, lastSlash)
    const fileName = sourceFile.slice(lastSlash + 1)
    const baseName = fileName.replace(/\.ts$/, '')
    const testPrefix = `${directory}/__tests__/${baseName}.`
    return !changedFiles.some((file) => file.startsWith(testPrefix) && file.endsWith('.ts'))
  })

  if (withoutTest.length === 0) return
  warn(
    `Os arquivos abaixo mudaram em \`application/\`/\`domain/\` sem um teste correspondente no mesmo diff:\n${withoutTest.map((file) => `- \`${file}\``).join('\n')}`
  )
}

const LARGE_PR_LINE_THRESHOLD = 500

function largePrWarning(): void {
  /*
   * Same runtime/type mismatch as gifSection() above: danger.github is undefined under `danger
   * local` (no real PR context), so this guards against a synchronous throw here discarding the
   * whole dangerfile report — the exact bug class the previous wave's final review found and
   * fixed for gifSection().
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- danger.github can be undefined at runtime (danger local mode) despite being typed as non-null
  const pr = danger.github?.pr
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, sonarjs/different-types-comparison -- pr's static type is always non-undefined because danger.github is (wrongly) typed non-null, but it's genuinely undefined at runtime under `danger local`
  if (pr === undefined) return
  const totalLines = pr.additions + pr.deletions
  if (totalLines <= LARGE_PR_LINE_THRESHOLD) return
  warn(
    `Esta PR tem ${totalLines} linhas alteradas (limite sugerido: ${LARGE_PR_LINE_THRESHOLD}). Considere quebrar em PRs menores para facilitar a review.`
  )
}
```

- [ ] **Step 2: Call both checks alongside the existing `noTestShortcuts({...})` call**

Find this exact block:

```ts
noTestShortcuts({
  testFilePredicate: (filePath) => /\.(?:unit|int|e2e)\.ts$/.test(filePath),
  skippedTests: 'fail'
})
```

Replace it with:

```ts
noTestShortcuts({
  testFilePredicate: (filePath) => /\.(?:unit|int|e2e)\.ts$/.test(filePath),
  skippedTests: 'fail'
})

sourceWithoutTestWarning()
largePrWarning()
```

- [ ] **Step 3: Lint**

Run: `pnpm exec eslint dangerfile.ts`
Expected: 0 problems. If the linter reports something on the two new `eslint-disable-next-line` comments (e.g. a different rule name flags the `pr === undefined` comparison), adjust the disabled rule list to match the actual output — don't guess, read what the linter actually says.

- [ ] **Step 4: Verify `sourceWithoutTestWarning()` fires on a real diff**

Create a scratch file to trigger the check (it will be removed before committing, it's only there to produce a real staged diff):

```bash
echo 'export const scratch = 1' > apps/dispatch-worker/src/email/application/__scratch-danger-test.ts
git add apps/dispatch-worker/src/email/application/__scratch-danger-test.ts dangerfile.ts
pnpm exec danger local -s -b HEAD --text-only
```

Expected: output includes a warning block containing "sem um teste correspondente" and lists `apps/dispatch-worker/src/email/application/__scratch-danger-test.ts`. Also confirm the run completes and prints the rest of the report (coverage/features/endpoints sections) — i.e. `largePrWarning()`'s guard didn't crash the module under `danger local`.

Clean up the scratch file before continuing:

```bash
git reset apps/dispatch-worker/src/email/application/__scratch-danger-test.ts
rm apps/dispatch-worker/src/email/application/__scratch-danger-test.ts
```

- [ ] **Step 5: Verify `largePrWarning()` fires against the real oversized PR**

PR #8 is the accumulating wave PR this branch feeds — by this point in the project it has well over 500 changed lines, so it's a real trigger, not a fabricated one:

```bash
DANGER_GITHUB_API_TOKEN=$(gh auth token) pnpm exec danger pr https://github.com/gravinawill/ruguin/pull/8 --text-only
```

Expected: output includes a warning containing "linhas alteradas" and "Considere quebrar em PRs menores".

- [ ] **Step 6: Commit**

```bash
git add dangerfile.ts
git commit -m "feat: warn on source changes without a matching test and on oversized PRs"
```

---

### Task 2: CODEOWNERS file and suggested-reviewers section

**Files:**
- Create: `.github/CODEOWNERS`
- Modify: `dangerfile.ts`

**Interfaces:**
- Consumes: nothing from Task 1 directly, but is inserted into the same region of `dangerfile.ts` Task 1 left — insert immediately after Task 1's `largePrWarning()` function and before `noTestShortcuts({...})`.
- Produces: `parseCodeowners(text: string): ReadonlyArray<{ pattern: string; owners: string[] }>`, `matchesCodeownersPattern(filePath: string, pattern: string): boolean`, `suggestedReviewersSection(): string` — not consumed by Task 3, but Task 3's own additions go in the same region, right after `suggestedReviewersSection()`.

- [ ] **Step 1: Create `.github/CODEOWNERS`**

```
* @gravinawill
```

(Single line, trailing newline, exactly as shown — this is the whole file. `gravinawill` is already in `.cspell.json`'s word list, so `pnpm check:spelling` passes without changes.)

- [ ] **Step 2: Add the CODEOWNERS-parsing functions to `dangerfile.ts`**

Immediately after the `largePrWarning()` function added in Task 1 (and before the `noTestShortcuts({...})` call), insert:

```ts
function parseCodeowners(text: string): ReadonlyArray<{ pattern: string; owners: string[] }> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const [pattern, ...owners] = line.split(/\s+/)
      return { pattern: pattern ?? '', owners }
    })
}

function matchesCodeownersPattern(filePath: string, pattern: string): boolean {
  if (pattern === '*') return true
  const normalized = pattern.replace(/^\//, '').replace(/\/$/, '')
  return filePath === normalized || filePath.startsWith(`${normalized}/`)
}

function suggestedReviewersSection(): string {
  if (!existsSync('.github/CODEOWNERS')) return ''
  const rules = parseCodeowners(readFileSync('.github/CODEOWNERS', 'utf8'))
  const changedFiles = [...danger.git.modified_files, ...danger.git.created_files]

  const owners = new Set<string>()
  for (const file of changedFiles) {
    for (const rule of rules) {
      if (matchesCodeownersPattern(file, rule.pattern)) {
        for (const owner of rule.owners) owners.add(owner)
      }
    }
  }

  if (owners.size === 0) return ''
  return `## 👀 Donos sugeridos (CODEOWNERS)\n\n${[...owners].join(', ')}`
}
```

- [ ] **Step 3: Add the new section to the `sections` array**

Find this exact line:

```ts
const sections = [coverageSection(), featuresSection(), endpointsSection(), gifSection()].filter(
  (section) => section !== ''
)
```

Replace it with:

```ts
const sections = [
  coverageSection(),
  featuresSection(),
  endpointsSection(),
  gifSection(),
  suggestedReviewersSection()
].filter((section) => section !== '')
```

- [ ] **Step 4: Lint**

Run: `pnpm exec eslint dangerfile.ts`
Expected: 0 problems.

- [ ] **Step 5: Verify the section renders**

Steps 2-3 already left `dangerfile.ts` with a real staged-able diff (the new functions plus the `sections` array change) — no throwaway content needed to get a non-empty diff:

```bash
git add dangerfile.ts .github/CODEOWNERS
pnpm exec danger local -s -b HEAD --text-only
```

Expected: output includes a section titled "Donos sugeridos (CODEOWNERS)" listing `@gravinawill`, since `dangerfile.ts` and `.github/CODEOWNERS` themselves are changed files matched by the `*` CODEOWNERS rule.

- [ ] **Step 6: Commit**

```bash
git add dangerfile.ts .github/CODEOWNERS
git commit -m "feat: suggest reviewers from CODEOWNERS on touched files"
```

---

### Task 3: Automatic area labels

**Files:**
- Modify: `dangerfile.ts`

**Interfaces:**
- Consumes: nothing from Task 1/2 directly; inserted immediately after Task 2's `suggestedReviewersSection()` function and before `noTestShortcuts({...})`.
- Produces: `const AREA_LABELS`, `applyAreaLabels(): Promise<void>` — terminal task, nothing downstream consumes these.

- [ ] **Step 1: Add the label mapping and the async apply function**

Immediately after `suggestedReviewersSection()` (and before `noTestShortcuts({...})`), insert:

```ts
const AREA_LABELS: ReadonlyArray<{ prefix: string; label: string }> = [
  { prefix: 'infrastructure/terraform/', label: 'terraform' },
  { prefix: 'infrastructure/k8s/', label: 'kubernetes' },
  { prefix: 'apps/core-server/', label: 'core-server' },
  { prefix: 'apps/dispatch-worker/', label: 'dispatch-worker' },
  { prefix: '.github/workflows/', label: 'github_actions' },
  { prefix: 'docs/', label: 'documentation' }
]

async function applyAreaLabels(): Promise<void> {
  const changedFiles = [...danger.git.modified_files, ...danger.git.created_files, ...danger.git.deleted_files]
  const labels = new Set<string>()
  for (const file of changedFiles) {
    for (const area of AREA_LABELS) {
      if (file.startsWith(area.prefix)) labels.add(area.label)
    }
  }
  if (labels.size === 0) return

  try {
    await danger.github.api.issues.addLabels({
      owner: danger.github.thisPR.owner,
      repo: danger.github.thisPR.repo,
      // `number` on GitHubAPIPR is deprecated in favor of `pull_number`, confirmed reading
      // danger's own GitHubDSL.d.ts — the Octokit `addLabels` param is `issue_number`, but a
      // PR's number and its underlying issue number are the same value on GitHub.
      issue_number: danger.github.thisPR.pull_number,
      labels: [...labels]
    })
  } catch (error: unknown) {
    warn(`Não consegui aplicar labels automáticas: ${String(error)}`)
  }
}
```

Note there is no `danger.github` guard here the way `gifSection()`/`largePrWarning()` need one: the entire `danger.github.api...` read-and-call sits inside the `try` block, so if `danger.github` is `undefined` (i.e. `danger local` mode), the resulting `TypeError` is caught by the existing `catch` and turned into a `warn()` — it never escapes to crash the module. This is a property of the code as written, not something to add defensively on top.

- [ ] **Step 2: Schedule it alongside the other `schedule(...)` calls**

Find this exact block (the end of the existing `lintReport` scheduling):

```ts
schedule(
  lintReport
    .scan({
      fileMask: '{apps,packages,configs}/*/eslint-checkstyle-report.xml',
      reportSeverity: true,
      requireLineModification: true
    })
    // eslint-disable-next-line unicorn/prefer-await, unicorn/prefer-top-level-await -- schedule() needs a promise handle, not real await: dangerfile.ts transpiles to CommonJS (see interop comment above), where top-level await isn't valid syntax
    .catch((error: unknown) => {
      warn(`danger-plugin-lint-report falhou: ${String(error)}`)
    })
)
```

Immediately after it (still before the final `const sections = [...]` block), insert:

```ts
// applyAreaLabels() already catches its own errors internally (see above) — no .catch() needed here.
schedule(applyAreaLabels())
```

- [ ] **Step 3: Lint**

Run: `pnpm exec eslint dangerfile.ts`
Expected: 0 problems.

- [ ] **Step 4: Verify no-crash behavior under `danger local`**

Steps 1-2 already left `dangerfile.ts` with a real staged-able diff (the new `AREA_LABELS`/`applyAreaLabels` code plus the new `schedule(...)` call) — no throwaway content needed:

```bash
git add dangerfile.ts
pnpm exec danger local -s -b HEAD --text-only
```

Expected: the run completes normally (full report still prints — coverage/features/endpoints/gif/suggested-reviewers sections all still present), proving `applyAreaLabels()`'s internal try/catch absorbed the `danger.github` `TypeError` under local mode rather than crashing the module. `dangerfile.ts` is at the repo root, not under any `AREA_LABELS` prefix, so this run won't itself apply a label — that's expected, this step only tests that the run doesn't crash; real label application is verified for real in Step 5.

- [ ] **Step 5: Verify real label application against PR #8**

This is a real, intentional write to the live PR — exactly the feature being verified, not a side effect to avoid. Confirm current labels first, then run against the real PR, then confirm the new labels landed:

```bash
gh pr view 8 --json labels --jq '.labels[].name'
DANGER_GITHUB_API_TOKEN=$(gh auth token) pnpm exec danger pr https://github.com/gravinawill/ruguin/pull/8 --text-only
gh pr view 8 --json labels --jq '.labels[].name'
```

Expected: the second `gh pr view` call shows new labels present that weren't in the first call's output — at minimum `terraform` and `documentation` should appear, since PR #8's accumulated diff touches `infrastructure/terraform/**` and `docs/**`. If `apps/core-server/**`, `apps/dispatch-worker/**`, `infrastructure/k8s/**`, or `.github/workflows/**` are also part of the diff, their labels should appear too.

- [ ] **Step 6: Commit**

```bash
git add dangerfile.ts
git commit -m "feat: apply labels automatically based on touched areas"
```

---

## Final Verification

After all three tasks:

```bash
pnpm exec tsc --noEmit
pnpm exec eslint dangerfile.ts
DANGER_GITHUB_API_TOKEN=$(gh auth token) pnpm exec danger pr https://github.com/gravinawill/ruguin/pull/8 --text-only
```

**Known pre-existing note on `tsc --noEmit`:** at plan-writing time, running `pnpm exec tsc --noEmit` at the repo root reports 5 pre-existing errors in `infrastructure/local/k6/core-server-health.ts` (missing `k6/options` types, untyped `__ENV`) — unrelated to `dangerfile.ts` and not introduced by this plan. Confirm any errors reported at final verification are exactly these same k6 errors and nothing new from `dangerfile.ts`; if `dangerfile.ts` itself has zero errors in the output, this step passes for the purposes of this plan.

The `danger pr` run should show, in one combined report: the coverage table, the features list, the endpoints table, the gif nudge (if applicable), the source-without-test warning (if applicable to whatever's currently diffed), the large-PR warning, the suggested-reviewers section, and confirmation (via the label check in Task 3 Step 5) that labels were applied — i.e. every check from this plan working together in the same run, matching Decision 5's positioning rule (nothing before the final `markdown()` call throws).
