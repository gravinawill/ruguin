# DangerJS and CodeRabbit Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PR-hygiene checks (gif nudge, test-shortcut blocking, TODO listing, inline lint
annotations) to `dangerfile.ts`, and teach `.coderabbit.yaml` the infrastructure conventions this
repo already settled on, so CodeRabbit stops re-flagging already-decided tradeoffs.

**Architecture:** Two independent tracks. `dangerfile.ts` gains four new sections/checks, three of
them backed by real, verified npm packages (`danger-plugin-no-test-shortcuts`,
`danger-plugin-todos`, `danger-plugin-lint-report`) and one reimplemented by hand (the gif nudge,
since the equivalent package is unmaintained and carries an unrelated dependency).
`danger-plugin-lint-report` needs a new CI step that generates a Checkstyle XML report from
ESLint, since ESLint 10 no longer bundles that formatter. `.coderabbit.yaml` gets two new
`path_instructions` blocks and one `path_filters` entry — no code dependency on the Danger changes.

**Tech Stack:** `danger` 13.0.10 (already installed), `danger-plugin-no-test-shortcuts`,
`danger-plugin-todos`, `danger-plugin-lint-report`, `eslint-formatter-checkstyle`, GitHub Actions.

## Global Constraints

- Every new npm package must be verified real and current via `npm view <name>` before it's
  referenced in a task — this plan already did that for all four packages named above; do not
  swap in an unverified alternative during implementation.
- `danger-plugin-no-test-shortcuts`'s `skippedTests` option defaults to `'ignore'` — it must be
  set to `'fail'` explicitly, or `.skip()` silently isn't caught (only `.only()` would be).
- `danger-plugin-todos` and `danger-plugin-lint-report`'s `scan()` are both async — both calls
  must be wrapped in `schedule()` from the `danger` package, or Danger's own process can exit
  before either resolves.
- Test file convention in this repo is `*.unit.ts` / `*.int.ts` / `*.e2e.ts`
  (`apps/core-server/CLAUDE.md`) — `testFilePredicate` must match exactly this pattern, not a
  generic `.test.ts`/`.spec.ts` guess.
- Every dangerfile.ts change is verified against a real Danger run in this plan
  (`pnpm exec danger pr <url> --text-only` against the live PR #8, or
  `pnpm exec danger local -s --text-only` against a scratch staged change) — never assumed from
  reading the plugin's README alone.

---

### Task 1: `.coderabbit.yaml` — infrastructure path_instructions

**Files:**
- Modify: `.coderabbit.yaml`

**Interfaces:**
- Produces: no code interface — this task only affects what CodeRabbit's own review engine reads
  on its next run. Nothing in later tasks depends on this file's content.

- [ ] **Step 1: Add the two new `path_instructions` entries**

Open `.coderabbit.yaml`. Find the `path_instructions:` list (currently ends with the
`.github/workflows/**` entry, around line 109-113). Add these two entries after it, keeping the
same indentation as the existing entries:

```yaml
    - path: 'infrastructure/terraform/**'
      instructions: >-
        Module sources here are registry-sourced (terraform-aws-modules/*, version constraints),
        not git-sourced — Checkov's CKV_TF_1 (commit-SHA pinning) only applies to git:: sources
        per its own documented scope, so don't flag registry version constraints under that rule.
        OTEL_EXPORTER_OTLP_ENDPOINT intentionally includes the full /v1/traces path:
        core-server's create-tracing-sdk.ts passes it straight through as OTLPTraceExporter's
        `url`, which is used as-is (no auto-suffixing) — only unset `url` triggers the SDK's own
        auto-append behavior. Kubernetes resources belong in the core-server namespace, not
        default. Secrets intentionally live in Terraform state via kubernetes_secret, not an
        External Secrets Operator — a documented tradeoff (see
        docs/superpowers/specs/2026-08-03-production-eks-observability-design.md Decision 10),
        not an oversight to re-flag every PR.

    - path: 'infrastructure/k8s/**'
      instructions: >-
        Resources belong in the core-server namespace, not default. TLS termination on the
        public NLB and immutable release tags on the Deployment's image are known, documented
        gaps (need an ACM cert/domain and a release-promotion pipeline that don't exist yet) —
        flag once per gap is enough, this doesn't need repeating on every PR that touches these
        files.
```

- [ ] **Step 2: Add the `path_filters` exclusion**

In the same file, find `path_filters:` (around line 40-58). Add this line right after
`'!pnpm-lock.yaml'`:

```yaml
    - '!infrastructure/terraform/**/.terraform.lock.hcl'
```

- [ ] **Step 3: Validate the YAML is well-formed**

```bash
python3 -c "import yaml; yaml.safe_load(open('.coderabbit.yaml'))" && echo "valid YAML"
```

Expected: `valid YAML`, no exception.

- [ ] **Step 4: Commit**

```bash
git add .coderabbit.yaml
git commit -m "docs: teach CodeRabbit this repo's Terraform/K8s conventions"
```

---

### Task 2: `dangerfile.ts` — gif nudge

**Files:**
- Modify: `dangerfile.ts`

**Interfaces:**
- Produces: `gifSection(): string` — a new function following the exact same shape as the
  existing `coverageSection()`/`featuresSection()`/`endpointsSection()` (returns `''` when there's
  nothing to report, a markdown string otherwise). Task 3, 4, and 5 do not depend on this
  function's name or return value — they add their own independent calls.

- [ ] **Step 1: Add the `gifSection` function**

Open `dangerfile.ts`. Add this function right after `endpointsSection()` (before the final
`const sections = [...]` line):

```ts
function gifSection(): string {
  const hasGif = /\.gif/.test(danger.github.pr.body ?? '')
  if (hasGif) return ''
  return '⚠️ Essa PR não tem gif na descrição. Considere adicionar um.'
}
```

- [ ] **Step 2: Wire it into the final `sections` array**

Find the last line of the file:

```ts
const sections = [coverageSection(), featuresSection(), endpointsSection()].filter((section) => section !== '')
```

Replace it with:

```ts
const sections = [coverageSection(), featuresSection(), endpointsSection(), gifSection()].filter(
  (section) => section !== ''
)
```

- [ ] **Step 3: Verify against the real, live PR #8**

PR #8's current description does not contain `.gif` (confirmed with
`gh pr view 8 --json body -q '.body'` — no `.gif` substring present), so this is a genuine
positive-path test, not a fabricated one.

```bash
DANGER_GITHUB_API_TOKEN=$(gh auth token) pnpm exec danger pr https://github.com/gravinawill/ruguin/pull/8 --text-only
```

Expected: the STDOUT output includes the line `⚠️ Essa PR não tem gif na descrição. Considere
adicionar um.` somewhere in the rendered markdown, alongside the existing coverage/features/
endpoints sections. This command only prints to STDOUT (`--text-only`) — it does not post
anything to the real PR.

- [ ] **Step 4: Commit**

```bash
git add dangerfile.ts
git commit -m "feat: nudge PRs without a gif in the description"
```

---

### Task 3: `dangerfile.ts` — block `.only()`/`.skip()` in tests

**Files:**
- Modify: `package.json` (root)
- Modify: `dangerfile.ts`

**Interfaces:**
- Consumes: nothing from Task 2.
- Produces: nothing later tasks depend on — `noTestShortcuts()` is a standalone call, its own
  section in Danger's output (this plugin posts its own `fail()`/`warn()` messages, it doesn't go
  through this file's `sections` array).

- [ ] **Step 1: Install the package**

```bash
pnpm add -D -w danger-plugin-no-test-shortcuts
```

- [ ] **Step 2: Add the import and the call**

Open `dangerfile.ts`. Add this import at the top, alongside the existing `danger` import:

```ts
import noTestShortcuts from 'danger-plugin-no-test-shortcuts'
```

Add this call right after the imports, before the `PACKAGES` constant:

```ts
noTestShortcuts({
  testFilePredicate: (filePath) => /\.(unit|int|e2e)\.ts$/.test(filePath),
  skippedTests: 'fail'
})
```

`skippedTests: 'fail'` is required — the package's own default is `'ignore'`, which would only
catch `.only()` and silently let `.skip()` through, defeating half the point of installing this.

- [ ] **Step 3: Verify it actually catches a `.only()` — scratch test, then discard**

Pick any existing unit test file, e.g. `packages/utils/src/either/__tests__/either.utility.unit.ts`.
Temporarily change one `it(` to `it.only(` in that file, then stage it:

```bash
sed -i.bak "0,/it(/{s/it(/it.only(/}" packages/utils/src/either/__tests__/either.utility.unit.ts
git add packages/utils/src/either/__tests__/either.utility.unit.ts
pnpm exec danger local -s -b HEAD --text-only
```

Expected: STDOUT includes a failure message from `danger-plugin-no-test-shortcuts` naming the
`.only()` it found (exact wording comes from the plugin, don't guess it — read what actually
prints).

Then discard the scratch change:

```bash
git restore --staged --worktree packages/utils/src/either/__tests__/either.utility.unit.ts
rm -f packages/utils/src/either/__tests__/either.utility.unit.ts.bak
git status --short packages/utils/src/either/__tests__/either.utility.unit.ts
```

Expected: no output from the last command (file is clean again).

- [ ] **Step 4: Run the package's own test suite to confirm nothing else broke**

```bash
pnpm --filter @ruguin/utils test:unit
```

Expected: all tests pass (the scratch `.only()` was discarded in Step 3, so this runs the real
suite unmodified).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml dangerfile.ts
git commit -m "feat: fail the PR when a test file has a forgotten .only or .skip"
```

---

### Task 4: `dangerfile.ts` — list new TODOs

**Files:**
- Modify: `package.json` (root)
- Modify: `dangerfile.ts`

**Interfaces:**
- Consumes: nothing from Task 2 or 3.
- Produces: nothing later tasks depend on — `todos()` posts its own section, independent of this
  file's `sections` array.

- [ ] **Step 1: Install the package**

```bash
pnpm add -D -w danger-plugin-todos
```

- [ ] **Step 2: Add the import and the scheduled call**

Open `dangerfile.ts`. Add these imports at the top, alongside the existing ones:

```ts
import { schedule } from 'danger'
import todos from 'danger-plugin-todos'
```

(If Task 3 already added an import line for `danger-plugin-no-test-shortcuts`, add these two new
import lines next to it — don't duplicate the existing `import { danger, markdown } from 'danger'`
line; add `schedule` to that same import instead: `import { danger, markdown, schedule } from
'danger'`.)

Add this call right after the `noTestShortcuts(...)` call from Task 3 (or after the `PACKAGES`
constant if Task 3 hasn't run yet in your working copy):

```ts
// todos() is async — schedule() is danger's own hook for that, confirmed from the plugin's
// own README usage example, not assumed.
schedule(todos())
```

- [ ] **Step 3: Verify it actually lists a new TODO — scratch change, then discard**

```bash
echo "// TODO: scratch line for danger-plugin-todos verification" >> packages/utils/src/index.ts
git add packages/utils/src/index.ts
DANGER_GITHUB_API_TOKEN=$(gh auth token) pnpm exec danger local -s -b HEAD --text-only
```

Expected: STDOUT includes a TODOs section listing the scratch line just added, with the file path
`packages/utils/src/index.ts`.

Then discard the scratch change:

```bash
git restore --staged --worktree packages/utils/src/index.ts
git status --short packages/utils/src/index.ts
```

Expected: no output (file is clean again).

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml dangerfile.ts
git commit -m "feat: list new TODOs added in the PR"
```

---

### Task 5: `dangerfile.ts` + CI — inline lint annotations

**Files:**
- Modify: `package.json` (root)
- Modify: `.github/workflows/ci.yml`
- Modify: `.gitignore`
- Modify: `dangerfile.ts`

**Interfaces:**
- Consumes: `schedule` from `danger` (same import Task 4 added — if Task 4 hasn't run yet in your
  working copy, add `import { danger, markdown, schedule } from 'danger'` yourself).
- Produces: nothing later tasks depend on — this is the last task in this plan.

- [ ] **Step 1: Install the packages**

```bash
pnpm add -D -w danger-plugin-lint-report eslint-formatter-checkstyle
```

- [ ] **Step 2: Add the `.gitignore` entry**

Open `.gitignore`. Add this line near the existing `coverage` entry:

```gitignore
eslint-checkstyle-report.xml
```

- [ ] **Step 3: Add the CI step**

Open `.github/workflows/ci.yml`. Find the `Check (types, lint, format, spelling)` step (currently
followed by the `Start Valkey` step). Add this new step right after `Check`, before `Start
Valkey`:

```yaml
      - name: Generate ESLint checkstyle report (for Danger)
        if: always() && github.event_name == 'pull_request'
        run: pnpm exec turbo run check:lint -- --format checkstyle --output-file eslint-checkstyle-report.xml
        continue-on-error: true
```

`if: always()` because the report is most useful exactly when `Check` already failed (shows
where, not just that it failed). `continue-on-error: true` for the same reason the existing
Danger step has it — generating a report should never be what fails the job.

- [ ] **Step 4: Add the import and the scheduled call**

Open `dangerfile.ts`. Add this import at the top, alongside the others:

```ts
import lintReport from 'danger-plugin-lint-report'
```

Add this call right after the `schedule(todos())` line from Task 4 (or after `noTestShortcuts(...)`
if Task 4 hasn't run yet):

```ts
schedule(
  lintReport.scan({
    fileMask: '**/eslint-checkstyle-report.xml',
    reportSeverity: true,
    requireLineModification: true
  })
)
```

- [ ] **Step 5: Verify the report generation command works**

```bash
pnpm exec turbo run check:lint --filter=@ruguin/utils -- --format checkstyle --output-file eslint-checkstyle-report.xml
cat packages/utils/eslint-checkstyle-report.xml
```

Expected: a `<?xml version="1.0" ...?><checkstyle ...>` document listing `<file>` entries for
every linted file in `packages/utils` (empty `<file>` tags mean no lint errors — that's correct,
not a failure).

- [ ] **Step 6: Verify Danger actually annotates a real lint violation — scratch violation, then discard**

Introduce an actual lint violation (an unused variable) in a tracked file:

```bash
printf '\nconst __scratchUnusedVar = 1\n' >> packages/utils/src/index.ts
git add packages/utils/src/index.ts
pnpm exec turbo run check:lint --filter=@ruguin/utils -- --format checkstyle --output-file eslint-checkstyle-report.xml || true
git add packages/utils/eslint-checkstyle-report.xml
DANGER_GITHUB_API_TOKEN=$(gh auth token) pnpm exec danger local -s -b HEAD --text-only
```

Expected: STDOUT includes an inline annotation on `packages/utils/src/index.ts` at the line of
`__scratchUnusedVar`, naming the ESLint rule that flagged it (e.g. `no-unused-vars` or this
project's equivalent — read what actually prints, don't assume the exact rule name).

Then discard both scratch artifacts:

```bash
git restore --staged --worktree packages/utils/src/index.ts
rm -f packages/utils/eslint-checkstyle-report.xml
git status --short packages/utils/src/index.ts packages/utils/eslint-checkstyle-report.xml
```

Expected: no output (both are clean/gone).

- [ ] **Step 7: Run the full check suite to confirm nothing is broken**

```bash
pnpm check
```

Expected: passes clean (types, lint, format, spelling) — same as before this task, since nothing
in this task changes what `pnpm check` itself does, only what an additional CI step generates
afterward.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml .github/workflows/ci.yml .gitignore dangerfile.ts
git commit -m "feat: annotate lint violations inline on the PR diff"
```

---

## Ordem e dependências

```
Task 1 (coderabbit.yaml) — independente, pode rodar em paralelo com o resto
Task 2 (gif) → Task 3 (no-test-shortcuts) → Task 4 (todos) → Task 5 (lint-report)
```

Tasks 2-5 tocam o mesmo arquivo (`dangerfile.ts`), por isso são sequenciais — cada uma parte do
estado que a anterior deixou. Task 1 é totalmente independente (arquivo diferente, sem relação de
código) e pode ser feita antes, depois, ou em paralelo.

## Riscos conhecidos

- **`danger local`, usado nos testes das Tasks 3-5, roda contra o diff local (staged vs. base) —
  não é o mesmo runtime que `danger ci` usa em produção**, mas exercita exatamente a mesma
  Dangerfile e os mesmos plugins, então é uma verificação real, não um mock.
- **`eslint-formatter-checkstyle` é uma republicação não-oficial** de um formatter que o próprio
  ESLint removeu do core (ver Riscos na spec). Se o pacote parar de ser mantido, o passo de CI
  falha ao gerar o relatório (mas `continue-on-error: true` evita que isso derrube o job — só a
  seção de lint do Danger fica vazia).
- **As mudanças em `dangerfile.ts` das Tasks 3-5 dependem da ordem de import/chamada não colidir**
  entre subagents diferentes rodando cada task em sequência — cada Step 2/4 desta lista já diz
  explicitamente onde inserir cada linha em relação à task anterior, exatamente para evitar isso.
