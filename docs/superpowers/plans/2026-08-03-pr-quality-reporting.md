# PR Quality Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give PR reviewers a single Danger comment (coverage, features, endpoints) plus six new
static-analysis/SCA checks (SonarCloud, Semgrep, CodeQL, Trivy filesystem scan, actionlint,
hadolint) that run at PR time, none overlapping CodeRabbit's LLM review or each other.

**Architecture:** `dangerfile.ts` at the repo root reads artifacts `pnpm test:coverage` already
produces (extended with two new reporters) and a static scan of controller files — no new runtime
infrastructure, no app boot. The six new checks are new jobs in `.github/workflows/ci.yml` (plus
one new workflow, `codeql.yml`, and one new step in `release-image.yml`), each using a different
already-provisioned account (SonarCloud, Semgrep) or a zero-account tool (CodeQL, Trivy,
actionlint, hadolint).

**Tech Stack:** Danger (`danger` npm package), Vitest reporters (`json-summary`,
`vitest-sonar-reporter`), SonarCloud, Semgrep AppSec Platform, GitHub CodeQL, Trivy, actionlint
(via `reviewdog/action-actionlint`), hadolint.

## Global Constraints

- Actions pinned by commit SHA, never a tag or branch — every SHA below was verified against
  `git/commits/{sha}` on the GitHub API to confirm it resolves to a real commit object, not an
  annotated tag object (see Onda 1's Global Constraints for why this matters).
- Zero cloud cost: SonarCloud and Semgrep AppSec Platform are free for public repositories;
  CodeQL is native to GitHub with no separate account.
- English in all code, comments, and commit messages.
- Danger's coverage table is report-only. The gate that fails a build on insufficient coverage is
  `vitest` itself (`pnpm test:coverage`), never Danger.
- SonarCloud's Quality Gate evaluates only new code ("Clean as You Code") — it must never be
  configured to fail on pre-existing repository debt.
- `SONAR_TOKEN` and `SEMGREP_APP_TOKEN` are already registered as GitHub Actions secrets on
  `gravinawill/ruguin` — no task in this plan needs to create them.
- SonarCloud project already exists: `sonar.projectKey=gravinawill_ruguin`,
  `sonar.organization=gravinawill` (confirmed via the SonarCloud API, not guessed).
- No task adds new runtime infrastructure (no Postgres/Valkey service added anywhere in this
  plan) — the endpoints feature is a static source scan specifically to avoid that cost.

---

### Task 1: Coverage reporters — `json-summary` and `vitest-sonar-reporter`

**Files:**

- Modify: `packages/cache/vitest.config.ts`
- Modify: `packages/env/vitest.config.ts`
- Modify: `packages/shared-domain/vitest.config.ts`
- Modify: `packages/utils/vitest.config.ts`
- Modify: `apps/core-server/vitest.config.ts`
- Modify: `packages/cache/package.json`, `packages/env/package.json`,
  `packages/shared-domain/package.json`, `packages/utils/package.json`,
  `apps/core-server/package.json` (devDependency)

**Interfaces:**

- Produces: `<package>/coverage/coverage-summary.json` (vitest's built-in `json-summary` format —
  `{ total: { statements: { pct }, branches: { pct }, functions: { pct }, lines: { pct } }, ... }`),
  consumed by Task 2's Dangerfile.
- Produces: `<package>/coverage/sonar-report.xml` (Generic Test Execution XML), consumed by Task 4's
  `sonar-project.properties`.

All five packages have byte-identical `coverage.reporter: ['text', 'lcov']` and top-level
`reporters: ['verbose']` today — the same two edits apply to all five files.

- [ ] **Step 1: Add the devDependency to all five packages**

```bash
pnpm --filter @ruguin/cache add -D vitest-sonar-reporter
pnpm --filter @ruguin/env add -D vitest-sonar-reporter
pnpm --filter @ruguin/shared-domain add -D vitest-sonar-reporter
pnpm --filter @ruguin/utils add -D vitest-sonar-reporter
pnpm --filter @ruguin/core-server add -D vitest-sonar-reporter
```

- [ ] **Step 2: Edit `packages/cache/vitest.config.ts`**

Change:

```ts
      reporter: ['text', 'lcov'],
```

to:

```ts
      reporter: ['text', 'lcov', 'json-summary'],
```

And change:

```ts
    reporters: ['verbose'],
```

to:

```ts
    reporters: ['verbose', 'vitest-sonar-reporter'],
    outputFile: { 'vitest-sonar-reporter': './coverage/sonar-report.xml' },
```

Apply the identical two changes to `packages/env/vitest.config.ts`,
`packages/shared-domain/vitest.config.ts`, `packages/utils/vitest.config.ts`, and
`apps/core-server/vitest.config.ts`.

- [ ] **Step 3: Run one package's coverage and inspect the output**

Run: `pnpm --filter @ruguin/cache test:cov`

Expected: the command still passes its threshold gate (same as before this change — these
reporters only add output files, they don't change what's measured). Then:

```bash
cat packages/cache/coverage/coverage-summary.json | head -5
cat packages/cache/coverage/sonar-report.xml | head -5
```

Expected: `coverage-summary.json` exists and its `total` key has `statements.pct`,
`branches.pct`, `functions.pct`, `lines.pct` as numbers. `sonar-report.xml` exists and starts with
an XML declaration followed by a `<testExecutions ...>` root element. If `vitest-sonar-reporter`
produces no file or errors, read its README under `node_modules/.pnpm/vitest-sonar-reporter@*` for
the exact expected `outputFile` key — the config above is the standard convention for vitest
custom reporters but this package's exact expected key wasn't executed before writing this plan.

- [ ] **Step 4: Repeat Step 3 for the remaining four packages**

```bash
pnpm --filter @ruguin/env test:cov
pnpm --filter @ruguin/shared-domain test:cov
pnpm --filter @ruguin/utils test:cov
pnpm --filter @ruguin/core-server test:cov
```

Expected: each produces both files under its own `coverage/` directory, same shape as Step 3.

- [ ] **Step 5: Confirm `coverage/` stays git-ignored**

Run: `git status --short` — none of the new `coverage-summary.json`/`sonar-report.xml` files
should appear as untracked (the root `.gitignore` already excludes `coverage/` for the existing
`lcov.info`/`text` output; these are new files in the same already-ignored directory).

- [ ] **Step 6: Commit**

```bash
git add packages/cache/vitest.config.ts packages/cache/package.json \
  packages/env/vitest.config.ts packages/env/package.json \
  packages/shared-domain/vitest.config.ts packages/shared-domain/package.json \
  packages/utils/vitest.config.ts packages/utils/package.json \
  apps/core-server/vitest.config.ts apps/core-server/package.json \
  pnpm-lock.yaml
git commit -m "feat(coverage): emit json-summary and Sonar test execution reports"
```

---

### Task 2: `dangerfile.ts` — coverage and features sections

**Files:**

- Create: `dangerfile.ts`
- Modify: `package.json` (root devDependency)
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: `<package>/coverage/coverage-summary.json` (Task 1) and each package's own
  `vitest.config.ts` `thresholds` block, read as text.
- Produces: exported nothing (Dangerfiles are entry points, not modules) — the file's side effect
  is calling Danger's `markdown()` once with the combined report. Task 3 extends this same file
  with a third section function.

- [ ] **Step 1: Add `danger` as a root devDependency**

```bash
pnpm add -Dw danger
```

- [ ] **Step 2: Write `dangerfile.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs'

import { danger, markdown } from 'danger'

type CoverageMetric = 'statements' | 'branches' | 'functions' | 'lines'
type CoverageSummary = { total: Record<CoverageMetric, { pct: number }> }
type Thresholds = Record<CoverageMetric, number>

const PACKAGES: ReadonlyArray<{ name: string; dir: string }> = [
  { name: '@ruguin/cache', dir: 'packages/cache' },
  { name: '@ruguin/core-server', dir: 'apps/core-server' },
  { name: '@ruguin/env', dir: 'packages/env' },
  { name: '@ruguin/shared-domain', dir: 'packages/shared-domain' },
  { name: '@ruguin/utils', dir: 'packages/utils' }
]

function readThresholds(configPath: string): Thresholds | undefined {
  if (!existsSync(configPath)) return undefined
  const text = readFileSync(configPath, 'utf8')
  const block = /thresholds:\s*\{([^}]+)\}/.exec(text)
  if (block === null) return undefined
  const pick = (key: CoverageMetric): number => {
    const found = new RegExp(`${key}:\\s*(\\d+)`).exec(block[1])
    return found === null ? 0 : Number(found[1])
  }
  return { statements: pick('statements'), branches: pick('branches'), functions: pick('functions'), lines: pick('lines') }
}

function readCoverage(summaryPath: string): CoverageSummary | undefined {
  if (!existsSync(summaryPath)) return undefined
  return JSON.parse(readFileSync(summaryPath, 'utf8')) as CoverageSummary
}

function coverageSection(): string {
  const rows = PACKAGES.map(({ name, dir }) => {
    const summary = readCoverage(`${dir}/coverage/coverage-summary.json`)
    const thresholds = readThresholds(`${dir}/vitest.config.ts`)
    if (summary === undefined || thresholds === undefined) return undefined
    const cell = (key: CoverageMetric): string => {
      const pct = summary.total[key].pct
      const min = thresholds[key]
      return `${pct.toFixed(2)}% ${pct >= min ? '✅' : '❌'} (min ${min})`
    }
    return `| ${name} | ${cell('statements')} | ${cell('branches')} | ${cell('functions')} | ${cell('lines')} |`
  }).filter((row): row is string => row !== undefined)

  if (rows.length === 0) return ''
  return [
    '## 📊 Coverage Report',
    '',
    '| Package | Statements | Branches | Functions | Lines |',
    '|---|---|---|---|---|',
    ...rows
  ].join('\n')
}

const COMMIT_TYPE_LABELS: Record<string, string> = {
  feat: 'Features',
  fix: 'Fixes',
  docs: 'Docs',
  refactor: 'Refactor',
  test: 'Tests',
  perf: 'Performance',
  build: 'Build',
  ci: 'CI'
}

function featuresSection(): string {
  const grouped = new Map<string, string[]>()
  for (const commit of danger.git.commits) {
    const firstLine = commit.message.split('\n')[0]
    const match = /^(\w+)(?:\([^)]+\))?:\s*(.+)/.exec(firstLine)
    if (match === null) continue
    const label = COMMIT_TYPE_LABELS[match[1]]
    if (label === undefined) continue
    const list = grouped.get(label) ?? []
    list.push(match[2])
    grouped.set(label, list)
  }

  if (grouped.size === 0) return ''
  const sections = [...grouped.entries()].map(
    ([label, items]) => `**${label}**\n${items.map((item) => `- ${item}`).join('\n')}`
  )
  return ['## 📋 Changes in this PR', '', ...sections].join('\n\n')
}

const sections = [coverageSection(), featuresSection()].filter((section) => section !== '')
if (sections.length > 0) markdown(sections.join('\n\n'))
```

- [ ] **Step 3: Add the Danger step to `.github/workflows/ci.yml`**

Add `pull-requests: write` to the `ci` job's permissions — the job currently has no job-level
`permissions:` block (only the top-level `contents: read`), so add one:

```yaml
  ci:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
```

Add this step after the existing `Test` step:

```yaml
      - name: Danger
        if: always() && github.event_name == 'pull_request'
        run: npx danger ci
        env:
          DANGER_GITHUB_API_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 4: Verify locally without opening a PR**

Danger's own local dry-run mode doesn't post a comment but does execute the Dangerfile end to end:

```bash
pnpm test:coverage
npx danger pr --dangerfile=dangerfile.ts <url-of-any-open-PR-on-this-repo>
```

If no PR is open, instead sanity-check just the coverage section in isolation:

```bash
node -e "
require('ts-node/register');
const fs = require('fs');
const path = 'packages/cache/coverage/coverage-summary.json';
console.log(fs.existsSync(path) ? 'coverage-summary.json present' : 'MISSING — run pnpm test:coverage first');
"
```

Expected: no thrown errors, and (if a PR URL was available) a preview of the coverage table printed
to the terminal.

- [ ] **Step 5: Commit**

```bash
git add dangerfile.ts package.json pnpm-lock.yaml .github/workflows/ci.yml
git commit -m "feat(ci): add Danger PR comment with coverage and feature summary"
```

---

### Task 3: Danger endpoints section

**Files:**

- Modify: `dangerfile.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks beyond the file itself.
- Produces: a third section appended to the same `sections` array Task 2 built, following the
  identical `if (sections.length > 0) markdown(...)` call already at the bottom of the file.

Verified against the one controller that exists today,
`apps/core-server/src/modules/health/health.controller.ts`:

```ts
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  @Get()
  ...
```

Two things this must handle correctly because of that file: `@Controller` takes an **object**
argument here (not a bare string), and the app enables URI versioning globally
(`apps/core-server/src/shared/infrastructure/bootstrap/configure-app.ts:36` —
`app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })`), so every route gets a
`/v1/` prefix **unless** its controller opts out with `version: VERSION_NEUTRAL`, exactly what
`health` does. A scanner that only handles `@Controller('string')` would silently produce a wrong
path for every controller in the codebase today.

- [ ] **Step 1: Add the endpoints function to `dangerfile.ts`**

First, extend the existing `node:fs` import Task 2 already added — change:

```ts
import { existsSync, readFileSync } from 'node:fs'
```

to:

```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs'
```

Then insert the rest above the `const sections = [...]` line, and read `DEFAULT_API_VERSION` from
`configure-app.ts`'s own `defaultVersion` value — update this constant if that call ever changes:

```ts
// Mirrors apps/core-server/src/shared/infrastructure/bootstrap/configure-app.ts's
// app.enableVersioning({ defaultVersion: '1' }) — this is a static scan, it can't read the
// running app's config, so it hardcodes the same default. Keep in sync if that call changes.
const DEFAULT_API_VERSION = '1'
const HTTP_METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete'] as const

function findControllerFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = `${dir}/${entry.name}`
    if (entry.isDirectory()) return findControllerFiles(fullPath)
    return entry.isFile() && entry.name.endsWith('.controller.ts') ? [fullPath] : []
  })
}

function extractControllerMeta(text: string): { path: string; version: string } {
  const objectForm = /@Controller\(\s*\{([^}]*)\}\s*\)/.exec(text)
  if (objectForm !== null) {
    const body = objectForm[1]
    const pathMatch = /\bpath:\s*['"`]([^'"`]*)['"`]/.exec(body)
    const versionMatch = /\bversion:\s*(VERSION_NEUTRAL|['"`]([^'"`]*)['"`])/.exec(body)
    const version =
      versionMatch === null
        ? DEFAULT_API_VERSION
        : versionMatch[1] === 'VERSION_NEUTRAL'
          ? ''
          : (versionMatch[2] ?? DEFAULT_API_VERSION)
    return { path: pathMatch === null ? '' : pathMatch[1], version }
  }
  const stringForm = /@Controller\(\s*['"`]([^'"`]*)['"`]\s*\)/.exec(text)
  return { path: stringForm === null ? '' : stringForm[1], version: DEFAULT_API_VERSION }
}

function endpointsSection(): string {
  const controllerFiles = existsSync('apps')
    ? readdirSync('apps').flatMap((app) => findControllerFiles(`apps/${app}/src`))
    : []

  const rows: string[] = []
  for (const file of controllerFiles) {
    const text = readFileSync(file, 'utf8')
    const { path: prefix, version } = extractControllerMeta(text)
    const versionSegment = version === '' ? '' : `v${version}`
    for (const method of HTTP_METHODS) {
      const regex = new RegExp(`@${method}\\(\\s*['"\`]?([^'"\`)]*)['"\`]?\\s*\\)`, 'g')
      let match: RegExpExecArray | null
      while ((match = regex.exec(text)) !== null) {
        const fullPath = [versionSegment, prefix, match[1]].filter((part) => part !== '').join('/')
        rows.push(`| ${method.toUpperCase()} | /${fullPath} |`)
      }
    }
  }

  if (rows.length === 0) return ''
  return [
    '## 🔌 API Endpoints',
    '',
    '| Método | Path |',
    '|---|---|',
    ...rows,
    '',
    `_${rows.length} endpoint${rows.length === 1 ? '' : 's'} no total_`
  ].join('\n')
}
```

- [ ] **Step 2: Wire it into the combined comment**

Change:

```ts
const sections = [coverageSection(), featuresSection()].filter((section) => section !== '')
```

to:

```ts
const sections = [coverageSection(), featuresSection(), endpointsSection()].filter(
  (section) => section !== ''
)
```

- [ ] **Step 3: Verify against the real controller**

```bash
node --experimental-strip-types -e "
$(node -e "console.log(require('fs').readFileSync('dangerfile.ts', 'utf8').split('const sections =')[0])")
console.log(endpointsSection())
"
```

Expected output contains exactly one row: `| GET | /health |` — no `/v1` prefix (because
`health.controller.ts` opts out with `VERSION_NEUTRAL`), and the object-form `@Controller` parsed
correctly. If the inline node eval above is awkward in practice, write a throwaway
`node --experimental-strip-types dangerfile.ts` invocation guarded behind
`if (require.main === module)` instead — either way, confirm the exact `/health` output before
moving on.

- [ ] **Step 4: Commit**

```bash
git add dangerfile.ts
git commit -m "feat(ci): add API endpoint listing to the Danger PR comment"
```

---

### Task 4: SonarCloud — Quality Gate on new code

**Files:**

- Create: `sonar-project.properties`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: `<package>/coverage/lcov.info` (already existed before this plan) and
  `<package>/coverage/sonar-report.xml` (Task 1), uploaded from the `ci` job and downloaded in the
  new `sonarqube` job.
- Produces: nothing consumed by later tasks — Sonar's PR decoration is posted by the SonarCloud
  GitHub App directly, independent of anything in this repository.

- [ ] **Step 1: Write `sonar-project.properties`**

```properties
sonar.projectKey=gravinawill_ruguin
sonar.organization=gravinawill
sonar.sources=apps,packages
sonar.tests=apps,packages
sonar.test.inclusions=**/__tests__/**
sonar.exclusions=**/generated/**,**/dist/**,**/coverage/**,**/*.config.ts,.claude/**
sonar.javascript.lcov.reportPaths=apps/core-server/coverage/lcov.info,packages/cache/coverage/lcov.info,packages/env/coverage/lcov.info,packages/shared-domain/coverage/lcov.info,packages/utils/coverage/lcov.info
sonar.testExecutionReportPaths=apps/core-server/coverage/sonar-report.xml,packages/cache/coverage/sonar-report.xml,packages/env/coverage/sonar-report.xml,packages/shared-domain/coverage/sonar-report.xml,packages/utils/coverage/sonar-report.xml
```

- [ ] **Step 2: Upload coverage as an artifact from the `ci` job**

Add as the last step of the `ci` job in `.github/workflows/ci.yml`:

```yaml
      - name: Upload coverage for SonarCloud
        if: always()
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: coverage-reports
          path: |
            apps/core-server/coverage
            packages/cache/coverage
            packages/env/coverage
            packages/shared-domain/coverage
            packages/utils/coverage
          retention-days: 1
```

- [ ] **Step 3: Add the `sonarqube` job**

```yaml
  sonarqube:
    needs: ci
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
        with:
          # SonarCloud attributes each finding to a commit/author via `git blame`, which needs
          # full history — the shallow checkout the `ci` job uses isn't enough here.
          fetch-depth: 0

      - name: Download coverage
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: coverage-reports

      - name: SonarCloud Scan
        uses: SonarSource/sonarqube-scan-action@22918119ff8e1ca75a623e15c8296b6ea4fbe28f # v8.2.1
        env:
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}

      - name: SonarCloud Quality Gate
        uses: SonarSource/sonarqube-quality-gate-action@cf038b0e0cdecfa9e56c198bbb7d21d751d62c3b # v1.2.0
        timeout-minutes: 5
        env:
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

- [ ] **Step 4: Verify locally that the properties file is syntactically valid**

```bash
node -e "
const fs = require('fs');
const text = fs.readFileSync('sonar-project.properties', 'utf8');
for (const line of text.split('\n').filter(Boolean)) {
  if (!/^[a-zA-Z0-9._]+=.*/.test(line)) throw new Error('Malformed line: ' + line);
}
console.log('OK, ' + text.split('\n').filter(Boolean).length + ' properties');
"
```

Expected: `OK, 7 properties`, no thrown error.

- [ ] **Step 5: Commit**

```bash
git add sonar-project.properties .github/workflows/ci.yml
git commit -m "feat(ci): add SonarCloud Quality Gate on new code"
```

---

### Task 5: Semgrep — SAST and supply-chain

**Files:**

- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `semgrep.sarif`, uploaded to GitHub's Security → Code scanning tab in the same job (no
  cross-task interface — self-contained).

- [ ] **Step 1: Confirm `semgrep ci`'s current SARIF flag**

Semgrep's CLI flags change between versions faster than this plan can track precisely. Before
writing the step, run:

```bash
docker run --rm semgrep/semgrep:1 semgrep ci --help | grep -i sarif
```

Expected: a flag that writes SARIF to a file (as of this plan's writing, `--sarif` combined with
`--output=<path>`, but confirm against the actual `--help` output before proceeding — if the flag
name differs, use the confirmed one in Step 2 instead).

- [ ] **Step 2: Add the `semgrep` job**

```yaml
  semgrep:
    runs-on: ubuntu-latest
    container:
      image: semgrep/semgrep:1
    permissions:
      contents: read
      security-events: write
    steps:
      - name: Checkout
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5

      - name: Semgrep
        run: semgrep ci --sarif --output=semgrep.sarif
        env:
          SEMGREP_APP_TOKEN: ${{ secrets.SEMGREP_APP_TOKEN }}

      - name: Upload SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@d1ba80a13dd99fba24a470575428917156a28b43 # v4.37.5
        with:
          sarif_file: semgrep.sarif
```

`semgrep ci` with `SEMGREP_APP_TOKEN` set uploads findings to the Semgrep AppSec Platform on its
own — the platform's own PR decoration is independent of the SARIF upload above, which exists
purely to also surface findings in GitHub's native Security tab.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "feat(ci): add Semgrep SAST and supply-chain scanning"
```

---

### Task 6: CodeQL

**Files:**

- Create: `.github/workflows/codeql.yml`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing consumed elsewhere — CodeQL posts directly to Security → Code scanning.

- [ ] **Step 1: Write `.github/workflows/codeql.yml`**

```yaml
name: CodeQL

on:
  push:
    branches: [master, develop]
  pull_request:
    branches: [master, develop]
    types: [opened, synchronize, reopened]
  schedule:
    # Catches newly-published CodeQL query issues against code that hasn't changed.
    - cron: '17 3 * * 1'

concurrency:
  group: codeql-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - name: Checkout
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5

      - name: Initialize CodeQL
        uses: github/codeql-action/init@d1ba80a13dd99fba24a470575428917156a28b43 # v4.37.5
        with:
          languages: javascript-typescript

      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@d1ba80a13dd99fba24a470575428917156a28b43 # v4.37.5
```

- [ ] **Step 2: Validate the YAML parses**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/codeql.yml'))" && echo "YAML OK"
```

Expected: `YAML OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/codeql.yml
git commit -m "feat(ci): add CodeQL analysis"
```

---

### Task 7: Trivy filesystem scan on the PR

**Files:**

- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: nothing.
- Produces: `trivy-fs.sarif`, uploaded in the same job.

- [ ] **Step 1: Add the `trivy-fs` job**

Reuses the exact same action already pinned in `release-image.yml`
(`aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25` # v0.36.0), scanning the
filesystem instead of a built image — this job needs no build step, so it runs in parallel with
`ci` rather than after it:

```yaml
  trivy-fs:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - name: Checkout
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5

      - name: Scan dependencies
        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        with:
          scan-type: fs
          format: sarif
          output: trivy-fs.sarif
          severity: HIGH,CRITICAL
          ignore-unfixed: true

      - name: Upload SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@d1ba80a13dd99fba24a470575428917156a28b43 # v4.37.5
        with:
          sarif_file: trivy-fs.sarif
```

This job does **not** set `exit-code: '1'` the way `release-image.yml`'s image scan does — a first
run against the existing dependency tree might already surface findings the team hasn't triaged
yet, and turning this into a hard merge-blocker on day one, before anyone has looked at what it
finds, would make Task 9's verification meaningless. Whether to add `exit-code: '1'` later, once
the first real findings have been triaged, is a decision for whoever reviews this task's output —
not baked into this step.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "feat(ci): scan dependencies for vulnerabilities before merge, not just after"
```

---

### Task 8: actionlint and hadolint

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release-image.yml`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Add the `actionlint` job to `ci.yml`**

```yaml
  actionlint:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5

      - name: actionlint
        uses: reviewdog/action-actionlint@50842263c20a7c46bd0065b9e624d3c569db061e # v1.73.0
```

- [ ] **Step 2: Add the `hadolint` step to `release-image.yml`**

Insert as the first step after `Checkout`, before `Set up Buildx` — it needs nothing but the
checked-out Dockerfile, and failing here means the expensive multi-arch build never starts:

```yaml
      - name: hadolint
        uses: hadolint/hadolint-action@2a66e89f53d0771bb131a7fa31f3136336094aa6 # v3.4.0
        with:
          dockerfile: apps/core-server/Dockerfile
```

- [ ] **Step 3: Verify `release-image.yml` still parses**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release-image.yml'))" && echo "YAML OK"
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo "YAML OK"
```

Expected: `YAML OK` twice.

- [ ] **Step 4: Run hadolint locally against the current Dockerfile, if the binary is available**

```bash
command -v hadolint >/dev/null && hadolint apps/core-server/Dockerfile || echo "hadolint not installed locally — CI will be the first real run"
```

Expected: either a clean pass, or a list of findings to fix in this same task (the Dockerfile
itself isn't in this plan's file list to modify, but a hadolint finding against it is exactly the
kind of "genuine failure at PR time" this task exists to catch — fix it here if one appears, don't
defer it).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release-image.yml
git commit -m "feat(ci): lint GitHub Actions workflows and the Dockerfile"
```

---

### Task 9: Close it out

**Files:**

- Modify: `docs/superpowers/specs/2026-08-03-pr-quality-reporting-design.md`

- [ ] **Step 1: Run the full local gate**

```bash
pnpm run check
pnpm build
pnpm test:coverage
```

Expected: all three pass, same as every prior task's verification — nothing in this plan should
have broken the existing gates.

- [ ] **Step 2: Validate every new/modified workflow file parses**

```bash
for f in .github/workflows/ci.yml .github/workflows/codeql.yml .github/workflows/release-image.yml; do
  python3 -c "import yaml; yaml.safe_load(open('$f'))" && echo "$f OK"
done
```

Expected: `OK` for all three.

- [ ] **Step 3: Record the result in the spec**

Add a `## Resultado` section to
`docs/superpowers/specs/2026-08-03-pr-quality-reporting-design.md` with: which checks actually
appeared on the first real PR run and under what exact names (needed for Step 4 below), whether
`vitest-sonar-reporter`'s `outputFile` key needed adjusting from what Task 1 assumed, whether the
Semgrep SARIF flag from Task 5 matched what was assumed, and whether the `trivy-fs` job surfaced
any pre-existing findings that need triage.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-03-pr-quality-reporting-design.md
git commit -m "docs: record what PR quality reporting actually produced"
```

- [ ] **Step 5: Tell the human partner about the one step only they can do**

After this plan's commits are pushed and the first real PR run confirms the exact check names,
branch protection on `develop`/`master` needs those names added under Settings → Branches →
Branch protection rules → Require status checks to pass, so they actually block merge rather than
merely reporting.

---

## Ordem e dependências

```
Task 1 (reporters)
  ├→ Task 2 (Danger: coverage + features) → Task 3 (Danger: endpoints)
  └→ Task 4 (SonarCloud)
Task 5 (Semgrep), Task 6 (CodeQL), Task 7 (Trivy-fs), Task 8 (actionlint/hadolint) — independentes
                                                                                       entre si e de 2–4
Todas → Task 9 (fechamento)
```

## Riscos conhecidos

- **`vitest-sonar-reporter`'s exact `outputFile` key is unverified.** Task 1's Step 3 is written as
  a real verification step specifically because of this — the config shown is the standard
  convention for Vitest custom reporters, not confirmed against this specific package's source
  before writing this plan.
- **Semgrep's exact SARIF CLI flag is unverified for the same reason.** Task 5's Step 1 exists to
  confirm it before the workflow step is written.
- **Six new required-looking checks land with nothing in branch protection listing them as
  required yet** — until Task 9's Step 5 is acted on, none of them can actually block a merge, no
  matter how loudly they fail.
