# Pre-commit Analysis Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `git commit` — from Claude Code or from a human at the terminal — passes through GitNexus structural checks, the full `ruflo analyze` suite, and (Claude-side only) an agentic code review before it's accepted.

**Architecture:** One shared TypeScript package (`packages/precommit-checks`) implements the deterministic checks and is invoked two ways: directly by `.husky/pre-commit` (every commit, no LLM involved) and via a stateful gate (`claude-precommit-gate.ts`) invoked by a new Claude Code `PreToolUse` hook that also enforces the agentic-review step through a diff-hash-keyed local state file.

**Tech Stack:** TypeScript (raw, no build — run via `tsx`, matching `packages/utils`/`packages/env` convention), Vitest for tests, Node built-ins only (`node:child_process`, `node:crypto`, `node:fs`) — no new npm dependencies.

## Global Constraints

- No new npm dependencies — everything uses Node built-ins already available (`tsx` is already a root devDependency).
- TypeScript strict mode (`@ruguin/typescript-config/base.json`), matching every other package.
- Tests live in `src/__tests__/*.unit.ts`, run via Vitest, mocking `node:child_process` — never invoke real `gitnexus`/`ruflo` CLIs in unit tests.
- Every CLI wrapper must treat "tool unavailable / crashed / network error" as a non-blocking warning, never as a blocking finding — only a real parsed result counts.
- The Claude Code side must never assume anything about `CLAUDE.md` prose; all enforcement is via the `PreToolUse` hook + the state file, never via an instruction the assistant is trusted to "remember."

---

## Task 1: Scaffold `packages/precommit-checks`

**Files:**
- Create: `packages/precommit-checks/package.json`
- Create: `packages/precommit-checks/tsconfig.json`
- Create: `packages/precommit-checks/vitest.config.ts`
- Create: `packages/precommit-checks/CLAUDE.md`

**Interfaces:**
- Produces: a workspace package `@ruguin/precommit-checks`, private, picked up automatically by root `vitest.config.ts`'s `projects: ['packages/*', ...]` glob — no root config change needed.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@ruguin/precommit-checks",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "check:lint": "eslint . --max-warnings 0",
    "check:types": "tsc --noEmit --pretty",
    "test:unit": "vitest run --project unit"
  },
  "devDependencies": {
    "@ruguin/eslint-config": "workspace:*",
    "@ruguin/typescript-config": "workspace:*",
    "typescript": "6.0.3",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "extends": "@ruguin/typescript-config/base.json",
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.unit.ts'],
    clearMocks: true,
    restoreMocks: true,
    reporters: ['verbose'],
    testTimeout: 5000,
    passWithNoTests: true
  }
})
```

- [ ] **Step 4: Create `CLAUDE.md`**

```markdown
# CLAUDE.md

## Purpose

`@ruguin/precommit-checks` — deterministic checks (GitNexus + ruflo) that run before every `git commit`, shared between `.husky/pre-commit` (every commit) and the Claude Code `PreToolUse` hook (Claude's own commits, layering an agentic-review gate on top). See `docs/superpowers/specs/2026-07-31-full-code-analysis-precommit-gate-design.md`.

## Structure

```
src/
  lib/
    extract-json.ts        # pulls a JSON value out of noisy CLI stdout
    gitnexus-checks.ts      # check --cycles, detect-changes, impact
    ruflo-checks.ts         # analyze diff --risk, complexity, dependencies, secrets, report-only
    baseline.ts              # .claude/pre-commit-baseline.json read/compare/write
    precommit-state.ts       # .git/.claude-precommit-state.json read/write + diff hash
  pre-commit-checks.ts       # entrypoint: Husky calls this directly
  claude-precommit-gate.ts   # entrypoint: Claude PreToolUse hook calls this
  mark-review-done.ts        # entrypoint: Claude calls this after the agentic review
```

## Rules

- No real CLI calls in `*.unit.ts` — mock `node:child_process`.
- A tool failing to run (missing binary, network) is a warning, never a blocking finding.
- Raw TS, no build — run via `tsx path/to/entrypoint.ts`.
```

- [ ] **Step 5: Install and verify the workspace picks it up**

Run: `pnpm install && pnpm --filter @ruguin/precommit-checks check:types`
Expected: succeeds (no source files yet, but `tsc --noEmit` on an empty `include` glob with no `.ts` files is a no-op success).

- [ ] **Step 6: Commit**

```bash
git add packages/precommit-checks
git commit -m "chore(precommit-checks): scaffold package"
```

---

## Task 2: `extractJson` — pull JSON out of noisy CLI stdout

Real motivation: `ruflo analyze complexity --format json` (and several other `ruflo analyze` subcommands) prints `[INFO] ...` and spinner text (`... Calculating complexity...`) on stdout *before* the JSON body. `JSON.parse(stdout)` fails on that; every ruflo wrapper needs this first.

**Files:**
- Create: `packages/precommit-checks/src/lib/extract-json.ts`
- Test: `packages/precommit-checks/src/lib/__tests__/extract-json.unit.ts`

**Interfaces:**
- Produces: `extractJson(stdout: string): unknown | null` — used by every `ruflo-checks.ts` wrapper in Task 6.

- [ ] **Step 1: Write the failing test**

```ts
// packages/precommit-checks/src/lib/__tests__/extract-json.unit.ts
import { describe, expect, it } from 'vitest'
import { extractJson } from '../extract-json'

describe('extractJson', () => {
  it('parses a clean JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('strips leading spinner/info noise before an object', () => {
    const noisy = '[INFO] Analyzing complexity: /repo\n... Calculating complexity...   {"files":[],"summary":{"total":0}}'
    expect(extractJson(noisy)).toEqual({ files: [], summary: { total: 0 } })
  })

  it('strips leading noise before an array', () => {
    const noisy = 'Scanning...\n[1,2,3]'
    expect(extractJson(noisy)).toEqual([1, 2, 3])
  })

  it('returns null when there is no JSON in the output', () => {
    expect(extractJson('No secrets detected.')).toBeNull()
  })

  it('returns null when the JSON-looking fragment is malformed', () => {
    expect(extractJson('prefix {not: valid json}')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- extract-json`
Expected: FAIL — `Cannot find module '../extract-json'`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/precommit-checks/src/lib/extract-json.ts
export function extractJson(stdout: string): unknown | null {
  const objectStart = stdout.indexOf('{')
  const arrayStart = stdout.indexOf('[')

  const candidates = [objectStart, arrayStart].filter((index) => index !== -1)
  if (candidates.length === 0) return null

  const start = Math.min(...candidates)

  try {
    return JSON.parse(stdout.slice(start))
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- extract-json`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add packages/precommit-checks/src/lib/extract-json.ts packages/precommit-checks/src/lib/__tests__/extract-json.unit.ts
git commit -m "feat(precommit-checks): add extractJson for noisy CLI stdout"
```

---

## Task 3: `precommit-state.ts` — diff hash + gate state file

**Files:**
- Create: `packages/precommit-checks/src/lib/precommit-state.ts`
- Test: `packages/precommit-checks/src/lib/__tests__/precommit-state.unit.ts`

**Interfaces:**
- Produces:
  - `computeDiffHash(diffText: string): string` — sha256 hex of the staged diff text.
  - `type PrecommitState = { diffHash: string; deterministic: 'pass' | 'fail'; agenticReviewDone: boolean; overrideApproved: boolean; overrideReason?: string }`
  - `readState(statePath: string): PrecommitState | null` — returns `null` on missing/corrupt file (never throws).
  - `writeState(statePath: string, state: PrecommitState): void`
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing test**

```ts
// packages/precommit-checks/src/lib/__tests__/precommit-state.unit.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeDiffHash, readState, writeState } from '../precommit-state'

describe('computeDiffHash', () => {
  it('is deterministic for the same input', () => {
    expect(computeDiffHash('diff --git a b')).toBe(computeDiffHash('diff --git a b'))
  })

  it('differs for different input', () => {
    expect(computeDiffHash('a')).not.toBe(computeDiffHash('b'))
  })
})

describe('readState / writeState', () => {
  let dir: string
  let statePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'precommit-state-'))
    statePath = join(dir, 'state.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when the file does not exist', () => {
    expect(readState(statePath)).toBeNull()
  })

  it('round-trips a written state', () => {
    const state = { diffHash: 'abc', deterministic: 'pass' as const, agenticReviewDone: false, overrideApproved: false }
    writeState(statePath, state)
    expect(readState(statePath)).toEqual(state)
  })

  it('returns null for a corrupted file instead of throwing', () => {
    writeState(statePath, { diffHash: 'x', deterministic: 'pass', agenticReviewDone: false, overrideApproved: false })
    // corrupt it
    require('node:fs').writeFileSync(statePath, '{not valid json')
    expect(readState(statePath)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- precommit-state`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/precommit-checks/src/lib/precommit-state.ts
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export type PrecommitState = {
  diffHash: string
  deterministic: 'pass' | 'fail'
  agenticReviewDone: boolean
  overrideApproved: boolean
  overrideReason?: string
}

export function computeDiffHash(diffText: string): string {
  return createHash('sha256').update(diffText).digest('hex')
}

export function readState(statePath: string): PrecommitState | null {
  if (!existsSync(statePath)) return null

  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as PrecommitState
  } catch {
    return null
  }
}

export function writeState(statePath: string, state: PrecommitState): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- precommit-state`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add packages/precommit-checks/src/lib/precommit-state.ts packages/precommit-checks/src/lib/__tests__/precommit-state.unit.ts
git commit -m "feat(precommit-checks): add diff-hash gate state read/write"
```

---

## Task 4: `baseline.ts` — regression comparison for complexity/dependencies

**Files:**
- Create: `packages/precommit-checks/src/lib/baseline.ts`
- Test: `packages/precommit-checks/src/lib/__tests__/baseline.unit.ts`

**Interfaces:**
- Produces:
  - `type Baseline = { updatedAt: string; complexity: Record<string, { cyclomatic: number; cognitive: number }>; dependencies: Record<string, { connections: number }> }`
  - `readBaseline(path: string): Baseline` — returns an empty baseline (`{updatedAt: '', complexity: {}, dependencies: {}}`) if missing/corrupt, never throws.
  - `writeBaseline(path: string, baseline: Baseline): void`
  - `complexityRegressed(baseline: Baseline, file: string, current: { cyclomatic: number; cognitive: number }): boolean` — `true` only if a baseline entry exists for `file` AND either metric increased.
  - `dependenciesRegressed(baseline: Baseline, file: string, current: { connections: number }): boolean` — same rule for connection count.

- [ ] **Step 1: Write the failing test**

```ts
// packages/precommit-checks/src/lib/__tests__/baseline.unit.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { complexityRegressed, dependenciesRegressed, readBaseline, writeBaseline } from '../baseline'

describe('readBaseline', () => {
  it('returns an empty baseline when the file is missing', () => {
    expect(readBaseline('/does/not/exist.json')).toEqual({ updatedAt: '', complexity: {}, dependencies: {} })
  })
})

describe('readBaseline / writeBaseline round-trip', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'baseline-'))
    path = join(dir, 'baseline.json')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips', () => {
    const baseline = {
      updatedAt: '2026-07-31T00:00:00.000Z',
      complexity: { 'src/a.ts': { cyclomatic: 3, cognitive: 2 } },
      dependencies: { 'src/a.ts': { connections: 4 } }
    }
    writeBaseline(path, baseline)
    expect(readBaseline(path)).toEqual(baseline)
  })
})

describe('complexityRegressed', () => {
  const baseline = { updatedAt: '', complexity: { 'src/a.ts': { cyclomatic: 5, cognitive: 5 } }, dependencies: {} }

  it('is false when there is no baseline entry for the file (new file)', () => {
    expect(complexityRegressed(baseline, 'src/new.ts', { cyclomatic: 100, cognitive: 100 })).toBe(false)
  })

  it('is false when both metrics stayed the same or improved', () => {
    expect(complexityRegressed(baseline, 'src/a.ts', { cyclomatic: 5, cognitive: 4 })).toBe(false)
  })

  it('is true when cyclomatic increased', () => {
    expect(complexityRegressed(baseline, 'src/a.ts', { cyclomatic: 6, cognitive: 5 })).toBe(true)
  })

  it('is true when cognitive increased', () => {
    expect(complexityRegressed(baseline, 'src/a.ts', { cyclomatic: 5, cognitive: 6 })).toBe(true)
  })
})

describe('dependenciesRegressed', () => {
  const baseline = { updatedAt: '', complexity: {}, dependencies: { 'src/a.ts': { connections: 3 } } }

  it('is false for a new file', () => {
    expect(dependenciesRegressed(baseline, 'src/new.ts', { connections: 50 })).toBe(false)
  })

  it('is true when connections increased', () => {
    expect(dependenciesRegressed(baseline, 'src/a.ts', { connections: 4 })).toBe(true)
  })

  it('is false when connections stayed the same', () => {
    expect(dependenciesRegressed(baseline, 'src/a.ts', { connections: 3 })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- baseline`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/precommit-checks/src/lib/baseline.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export type Baseline = {
  updatedAt: string
  complexity: Record<string, { cyclomatic: number; cognitive: number }>
  dependencies: Record<string, { connections: number }>
}

const EMPTY_BASELINE: Baseline = { updatedAt: '', complexity: {}, dependencies: {} }

export function readBaseline(path: string): Baseline {
  if (!existsSync(path)) return EMPTY_BASELINE

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Baseline
  } catch {
    return EMPTY_BASELINE
  }
}

export function writeBaseline(path: string, baseline: Baseline): void {
  writeFileSync(path, JSON.stringify(baseline, null, 2))
}

export function complexityRegressed(
  baseline: Baseline,
  file: string,
  current: { cyclomatic: number; cognitive: number }
): boolean {
  const previous = baseline.complexity[file]
  if (!previous) return false

  return current.cyclomatic > previous.cyclomatic || current.cognitive > previous.cognitive
}

export function dependenciesRegressed(baseline: Baseline, file: string, current: { connections: number }): boolean {
  const previous = baseline.dependencies[file]
  if (!previous) return false

  return current.connections > previous.connections
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- baseline`
Expected: PASS (9/9)

- [ ] **Step 5: Commit**

```bash
git add packages/precommit-checks/src/lib/baseline.ts packages/precommit-checks/src/lib/__tests__/baseline.unit.ts
git commit -m "feat(precommit-checks): add complexity/dependencies regression baseline"
```

---

## Task 5: `gitnexus-checks.ts` — cycle check, detect-changes, per-symbol impact

Real CLI shapes captured this session (do not guess — these are actual observed outputs):
- `node .gitnexus/run.cjs check --cycles --json` → `{"status":"clean","cycleCount":0,"cycles":[]}`
- `node .gitnexus/run.cjs detect-changes --scope staged` → plain text, no `--json` flag exists (confirmed: `error: unknown option '--json'`). Contains a `Risk level: <word>` line and, under `Changed symbols:`, lines like `  Symbol <name> → <filePath>`.
- `node .gitnexus/run.cjs impact "<symbol>" -d upstream --summary-only` → JSON with a top-level `"risk": "LOW"|"MEDIUM"|"HIGH"|"CRITICAL"` string field.

**Files:**
- Create: `packages/precommit-checks/src/lib/gitnexus-checks.ts`
- Test: `packages/precommit-checks/src/lib/__tests__/gitnexus-checks.unit.ts`

**Interfaces:**
- Consumes: `extractJson` from Task 2 (for the `impact` call, which is clean JSON but still routed through it for consistency and future-proofing against stray log lines).
- Produces:
  - `type CheckResult = { blocking: boolean; warning: boolean; message: string }`
  - `runCycleCheck(exec: ExecFn): CheckResult`
  - `runDetectChanges(exec: ExecFn): { result: CheckResult; changedSymbols: string[] }`
  - `runImpactForSymbol(exec: ExecFn, symbol: string): CheckResult`
  - `type ExecFn = (command: string, args: string[]) => { status: number; stdout: string; stderr: string }` — injected so tests never spawn a real process. Implementations use `node:child_process`'s `spawnSync`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/precommit-checks/src/lib/__tests__/gitnexus-checks.unit.ts
import { describe, expect, it, vi } from 'vitest'
import { runCycleCheck, runDetectChanges, runImpactForSymbol } from '../gitnexus-checks'

describe('runCycleCheck', () => {
  it('does not block when clean', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '{"status":"clean","cycleCount":0,"cycles":[]}', stderr: '' })
    const result = runCycleCheck(exec)
    expect(result.blocking).toBe(false)
  })

  it('blocks when a cycle is found', () => {
    const exec = vi.fn().mockReturnValue({
      status: 0,
      stdout: '{"status":"cycles-found","cycleCount":1,"cycles":["a.ts -> b.ts -> a.ts"]}',
      stderr: ''
    })
    const result = runCycleCheck(exec)
    expect(result.blocking).toBe(true)
    expect(result.message).toContain('a.ts -> b.ts -> a.ts')
  })

  it('warns (does not block) when the tool is unavailable', () => {
    const exec = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'command not found' })
    const result = runCycleCheck(exec)
    expect(result.blocking).toBe(false)
    expect(result.warning).toBe(true)
  })
})

describe('runDetectChanges', () => {
  const sample = [
    'Changes: 2 files, 2 symbols',
    'Affected processes: 0',
    'Risk level: high',
    '',
    'Changed symbols:',
    '  Symbol RequestEmailSendUseCase → src/email/request-email-send.use-case.ts',
    '  Symbol EmailRepository → src/email/email.repository.ts'
  ].join('\n')

  it('blocks on HIGH/CRITICAL risk and extracts changed symbol names', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: sample, stderr: '' })
    const { result, changedSymbols } = runDetectChanges(exec)
    expect(result.blocking).toBe(true)
    expect(changedSymbols).toEqual(['RequestEmailSendUseCase', 'EmailRepository'])
  })

  it('does not block on low risk', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: sample.replace('Risk level: high', 'Risk level: low'), stderr: '' })
    const { result } = runDetectChanges(exec)
    expect(result.blocking).toBe(false)
  })
})

describe('runImpactForSymbol', () => {
  it('blocks on HIGH risk', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '{"target":{"name":"X"},"risk":"HIGH","impactedCount":9}', stderr: '' })
    expect(runImpactForSymbol(exec, 'X').blocking).toBe(true)
  })

  it('does not block on LOW risk', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '{"target":{"name":"X"},"risk":"LOW","impactedCount":1}', stderr: '' })
    expect(runImpactForSymbol(exec, 'X').blocking).toBe(false)
  })

  it('warns instead of blocking when the symbol cannot be resolved', () => {
    const exec = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'ambiguous symbol' })
    const result = runImpactForSymbol(exec, 'X')
    expect(result.blocking).toBe(false)
    expect(result.warning).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- gitnexus-checks`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/precommit-checks/src/lib/gitnexus-checks.ts
import { extractJson } from './extract-json'

export type ExecResult = { status: number; stdout: string; stderr: string }
export type ExecFn = (command: string, args: string[]) => ExecResult
export type CheckResult = { blocking: boolean; warning: boolean; message: string }

const BLOCKING_RISK_LEVELS = new Set(['HIGH', 'CRITICAL'])

export function runCycleCheck(exec: ExecFn): CheckResult {
  const { status, stdout, stderr } = exec('node', ['.gitnexus/run.cjs', 'check', '--cycles', '--json'])

  const parsed = extractJson(stdout) as { status?: string; cycleCount?: number; cycles?: string[] } | null
  if (status !== 0 || !parsed) {
    return { blocking: false, warning: true, message: `gitnexus check --cycles unavailable: ${stderr || 'no output'}` }
  }

  if ((parsed.cycleCount ?? 0) > 0) {
    return { blocking: true, warning: false, message: `Import cycle(s) found:\n${(parsed.cycles ?? []).join('\n')}` }
  }

  return { blocking: false, warning: false, message: 'No circular imports found.' }
}

export function runDetectChanges(exec: ExecFn): { result: CheckResult; changedSymbols: string[] } {
  const { status, stdout, stderr } = exec('node', ['.gitnexus/run.cjs', 'detect-changes', '--scope', 'staged'])

  if (status !== 0) {
    return {
      result: { blocking: false, warning: true, message: `gitnexus detect-changes unavailable: ${stderr || 'no output'}` },
      changedSymbols: []
    }
  }

  const riskMatch = /Risk level:\s*(\w+)/i.exec(stdout)
  const risk = (riskMatch?.[1] ?? 'unknown').toUpperCase()

  const changedSymbols = [...stdout.matchAll(/^\s*Symbol\s+(.+?)\s+→/gm)].map((match) => match[1])

  const blocking = BLOCKING_RISK_LEVELS.has(risk)
  return {
    result: { blocking, warning: false, message: `detect-changes risk level: ${risk}` },
    changedSymbols
  }
}

export function runImpactForSymbol(exec: ExecFn, symbol: string): CheckResult {
  const { status, stdout, stderr } = exec('node', [
    '.gitnexus/run.cjs',
    'impact',
    symbol,
    '-d',
    'upstream',
    '--summary-only'
  ])

  const parsed = extractJson(stdout) as { risk?: string } | null
  if (status !== 0 || !parsed) {
    return { blocking: false, warning: true, message: `gitnexus impact "${symbol}" unavailable: ${stderr || 'no output'}` }
  }

  const risk = (parsed.risk ?? 'UNKNOWN').toUpperCase()
  return {
    blocking: BLOCKING_RISK_LEVELS.has(risk),
    warning: false,
    message: `impact "${symbol}": risk ${risk}`
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- gitnexus-checks`
Expected: PASS (8/8)

- [ ] **Step 5: Commit**

```bash
git add packages/precommit-checks/src/lib/gitnexus-checks.ts packages/precommit-checks/src/lib/__tests__/gitnexus-checks.unit.ts
git commit -m "feat(precommit-checks): add gitnexus cycle/detect-changes/impact wrappers"
```

---

## Task 6: `ruflo-checks.ts` — diff risk, secrets, complexity/dependencies regression, report-only

Real CLI shapes captured this session:
- `npx @claude-flow/cli@latest analyze diff --risk --format json` → noisy stdout, JSON body has `risk.overall: "low"|"medium"|"high"|"critical"`.
- `npx @claude-flow/cli@latest security secrets --action scan -p .` → **no JSON support** (confirmed: `--format json` is silently ignored). Plain text; passing scan prints the literal line `No secrets detected.`.
- `npx @claude-flow/cli@latest analyze complexity --format json` → noisy stdout, JSON body `{"files":[{"file":"<absolute path>","cyclomatic":N,"cognitive":N,...}],"summary":{...}}`. `-p <dir>` does **not** reliably scope the scan (confirmed: still returns entries outside the given path) — always treat it as a full-repo result and filter client-side by matching `file` against the staged files' absolute paths.
- `npx @claude-flow/cli@latest analyze dependencies --format json` → noisy stdout, JSON body `{"nodes":[{"path":"<repo-relative path>",...}],"edges":[{"source":"<path>","target":"<path>","type":"...","weight":N}],"metadata":{...}}`. There is no per-node "connections" field — compute it as the count of edges whose `source` or `target` equals the file's relative path.

**Files:**
- Create: `packages/precommit-checks/src/lib/ruflo-checks.ts`
- Test: `packages/precommit-checks/src/lib/__tests__/ruflo-checks.unit.ts`

**Interfaces:**
- Consumes: `extractJson` (Task 2), `Baseline`/`complexityRegressed`/`dependenciesRegressed` (Task 4), `ExecFn`/`CheckResult` (Task 5 — reused, not redefined).
- Produces:
  - `runDiffRisk(exec: ExecFn): CheckResult`
  - `runSecretsScan(exec: ExecFn): CheckResult`
  - `runComplexityRegression(exec: ExecFn, repoRoot: string, stagedFiles: string[], baseline: Baseline): CheckResult`
  - `runDependenciesRegression(exec: ExecFn, stagedFiles: string[], baseline: Baseline): CheckResult`
  - `runReportOnly(exec: ExecFn, subcommand: string): { subcommand: string; output: unknown | string }` — used for `symbols`, `imports`, `boundaries`, `modules`, `ast`, `deps`; falls back to raw stdout string when the output isn't parseable JSON.

- [ ] **Step 1: Write the failing test**

```ts
// packages/precommit-checks/src/lib/__tests__/ruflo-checks.unit.ts
import { describe, expect, it, vi } from 'vitest'
import type { Baseline } from '../baseline'
import {
  runComplexityRegression,
  runDependenciesRegression,
  runDiffRisk,
  runReportOnly,
  runSecretsScan
} from '../ruflo-checks'

describe('runDiffRisk', () => {
  it('blocks when risk.overall is not low', () => {
    const exec = vi.fn().mockReturnValue({
      status: 0,
      stdout: '[INFO] noise\n{"risk":{"overall":"high","score":80}}',
      stderr: ''
    })
    expect(runDiffRisk(exec).blocking).toBe(true)
  })

  it('does not block on low risk', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '{"risk":{"overall":"low","score":3}}', stderr: '' })
    expect(runDiffRisk(exec).blocking).toBe(false)
  })
})

describe('runSecretsScan', () => {
  it('does not block when "No secrets detected." is present', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: 'Scanned 10 files\n\nNo secrets detected.\n', stderr: '' })
    expect(runSecretsScan(exec).blocking).toBe(false)
  })

  it('blocks when the pass message is absent', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: 'Scanned 10 files\n\n1 potential secret found in src/config.ts', stderr: '' })
    expect(runSecretsScan(exec).blocking).toBe(true)
  })
})

describe('runComplexityRegression', () => {
  const baseline: Baseline = {
    updatedAt: '',
    complexity: { 'src/a.ts': { cyclomatic: 5, cognitive: 5 } },
    dependencies: {}
  }

  it('blocks when a staged file regressed', () => {
    const exec = vi.fn().mockReturnValue({
      status: 0,
      stdout: '{"files":[{"file":"/repo/src/a.ts","cyclomatic":9,"cognitive":9,"rating":"Complex","flagged":true}],"summary":{}}',
      stderr: ''
    })
    const result = runComplexityRegression(exec, '/repo', ['src/a.ts'], baseline)
    expect(result.blocking).toBe(true)
  })

  it('does not block when no staged file regressed', () => {
    const exec = vi.fn().mockReturnValue({
      status: 0,
      stdout: '{"files":[{"file":"/repo/src/a.ts","cyclomatic":5,"cognitive":5,"rating":"Simple","flagged":false}],"summary":{}}',
      stderr: ''
    })
    const result = runComplexityRegression(exec, '/repo', ['src/a.ts'], baseline)
    expect(result.blocking).toBe(false)
  })
})

describe('runDependenciesRegression', () => {
  const baseline: Baseline = { updatedAt: '', complexity: {}, dependencies: { 'src/a.ts': { connections: 1 } } }

  it('blocks when a staged file has more connections than baseline', () => {
    const exec = vi.fn().mockReturnValue({
      status: 0,
      stdout:
        '{"nodes":[{"path":"src/a.ts"},{"path":"src/b.ts"}],"edges":[{"source":"src/a.ts","target":"src/b.ts"},{"source":"src/c.ts","target":"src/a.ts"}]}',
      stderr: ''
    })
    const result = runDependenciesRegression(exec, ['src/a.ts'], baseline)
    expect(result.blocking).toBe(true)
  })
})

describe('runReportOnly', () => {
  it('parses JSON output when possible', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '[INFO] noise\n{"symbols":[]}', stderr: '' })
    expect(runReportOnly(exec, 'symbols')).toEqual({ subcommand: 'symbols', output: { symbols: [] } })
  })

  it('falls back to raw text when the output is not JSON', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: 'plain text report', stderr: '' })
    expect(runReportOnly(exec, 'boundaries')).toEqual({ subcommand: 'boundaries', output: 'plain text report' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- ruflo-checks`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/precommit-checks/src/lib/ruflo-checks.ts
import { resolve } from 'node:path'
import { type Baseline, complexityRegressed, dependenciesRegressed } from './baseline'
import { extractJson } from './extract-json'
import type { CheckResult, ExecFn } from './gitnexus-checks'

const RUFLO = 'npx'
const RUFLO_ARGS_PREFIX = ['@claude-flow/cli@latest']
const BLOCKING_RISK = new Set(['medium', 'high', 'critical'])

export function runDiffRisk(exec: ExecFn): CheckResult {
  const { status, stdout, stderr } = exec(RUFLO, [...RUFLO_ARGS_PREFIX, 'analyze', 'diff', '--risk', '--format', 'json'])

  const parsed = extractJson(stdout) as { risk?: { overall?: string } } | null
  if (status !== 0 || !parsed) {
    return { blocking: false, warning: true, message: `ruflo analyze diff --risk unavailable: ${stderr || 'no output'}` }
  }

  const overall = (parsed.risk?.overall ?? 'low').toLowerCase()
  return { blocking: BLOCKING_RISK.has(overall) && overall !== 'low', warning: false, message: `diff risk: ${overall}` }
}

export function runSecretsScan(exec: ExecFn): CheckResult {
  const { status, stdout, stderr } = exec(RUFLO, [...RUFLO_ARGS_PREFIX, 'security', 'secrets', '--action', 'scan', '-p', '.'])

  if (status !== 0 && !stdout) {
    return { blocking: false, warning: true, message: `ruflo security secrets unavailable: ${stderr || 'no output'}` }
  }

  const clean = stdout.includes('No secrets detected.')
  return { blocking: !clean, warning: false, message: clean ? 'No secrets detected.' : stdout.trim() }
}

export function runComplexityRegression(
  exec: ExecFn,
  repoRoot: string,
  stagedFiles: string[],
  baseline: Baseline
): CheckResult {
  const { status, stdout, stderr } = exec(RUFLO, [...RUFLO_ARGS_PREFIX, 'analyze', 'complexity', '--format', 'json'])

  const parsed = extractJson(stdout) as { files?: { file: string; cyclomatic: number; cognitive: number }[] } | null
  if (status !== 0 || !parsed) {
    return { blocking: false, warning: true, message: `ruflo analyze complexity unavailable: ${stderr || 'no output'}` }
  }

  const byAbsolutePath = new Map((parsed.files ?? []).map((entry) => [entry.file, entry]))
  const regressions = stagedFiles.filter((relativePath) => {
    const entry = byAbsolutePath.get(resolve(repoRoot, relativePath))
    if (!entry) return false
    return complexityRegressed(baseline, relativePath, { cyclomatic: entry.cyclomatic, cognitive: entry.cognitive })
  })

  return {
    blocking: regressions.length > 0,
    warning: false,
    message: regressions.length > 0 ? `Complexity regressed in: ${regressions.join(', ')}` : 'No complexity regression.'
  }
}

export function runDependenciesRegression(exec: ExecFn, stagedFiles: string[], baseline: Baseline): CheckResult {
  const { status, stdout, stderr } = exec(RUFLO, [...RUFLO_ARGS_PREFIX, 'analyze', 'dependencies', '--format', 'json'])

  const parsed = extractJson(stdout) as { edges?: { source: string; target: string }[] } | null
  if (status !== 0 || !parsed) {
    return { blocking: false, warning: true, message: `ruflo analyze dependencies unavailable: ${stderr || 'no output'}` }
  }

  const edges = parsed.edges ?? []
  const regressions = stagedFiles.filter((relativePath) => {
    const connections = edges.filter((edge) => edge.source === relativePath || edge.target === relativePath).length
    return dependenciesRegressed(baseline, relativePath, { connections })
  })

  return {
    blocking: regressions.length > 0,
    warning: false,
    message: regressions.length > 0 ? `Dependency count regressed in: ${regressions.join(', ')}` : 'No dependency regression.'
  }
}

export function runReportOnly(exec: ExecFn, subcommand: string): { subcommand: string; output: unknown | string } {
  const { stdout } = exec(RUFLO, [...RUFLO_ARGS_PREFIX, 'analyze', subcommand, '--format', 'json'])

  const parsed = extractJson(stdout)
  return { subcommand, output: parsed ?? stdout.trim() }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- ruflo-checks`
Expected: PASS (9/9)

- [ ] **Step 5: Commit**

```bash
git add packages/precommit-checks/src/lib/ruflo-checks.ts packages/precommit-checks/src/lib/__tests__/ruflo-checks.unit.ts
git commit -m "feat(precommit-checks): add ruflo diff-risk/secrets/regression/report wrappers"
```

---

## Task 7: `pre-commit-checks.ts` — main orchestrator (used directly by Husky)

**Files:**
- Create: `packages/precommit-checks/src/pre-commit-checks.ts`
- Test: `packages/precommit-checks/src/__tests__/pre-commit-checks.unit.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6 (`gitnexus-checks.ts`, `ruflo-checks.ts`, `baseline.ts`), plus a real `ExecFn` implementation built on `node:child_process`'s `spawnSync`.
- Produces:
  - `runAllChecks(exec: ExecFn, repoRoot: string, stagedFiles: string[], baseline: Baseline): { pass: boolean; findings: string[]; warnings: string[]; report: Record<string, unknown> }` — pure orchestration function, fully testable without touching the filesystem or a real process.
  - A CLI `main()` that: reads staged files via `git diff --cached --name-only`, reads/writes the baseline file at `.claude/pre-commit-baseline.json`, writes the report to `.git/.claude-precommit-report.json`, prints `PRECOMMIT_RESULT=PASS`/`PRECOMMIT_RESULT=FAIL`, and exits `0`/`1` (this part is not unit-tested — it's the thin I/O shell around `runAllChecks`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/precommit-checks/src/__tests__/pre-commit-checks.unit.ts
import { describe, expect, it, vi } from 'vitest'
import { runAllChecks } from '../pre-commit-checks'

function execReturning(mapping: Record<string, { status: number; stdout: string; stderr?: string }>) {
  return vi.fn((_command: string, args: string[]) => {
    const key = args.join(' ')
    const match = Object.entries(mapping).find(([pattern]) => key.includes(pattern))
    if (!match) return { status: 0, stdout: '', stderr: '' }
    return { status: match[1].status, stdout: match[1].stdout, stderr: match[1].stderr ?? '' }
  })
}

const CLEAN_MAPPING = {
  'check --cycles': { status: 0, stdout: '{"status":"clean","cycleCount":0,"cycles":[]}' },
  'detect-changes': { status: 0, stdout: 'Changes: 0 files, 0 symbols\nRisk level: low\n\nChanged symbols:\n' },
  'diff --risk': { status: 0, stdout: '{"risk":{"overall":"low"}}' },
  'security secrets': { status: 0, stdout: 'No secrets detected.' },
  'analyze complexity': { status: 0, stdout: '{"files":[],"summary":{}}' },
  'analyze dependencies': { status: 0, stdout: '{"nodes":[],"edges":[]}' },
  'analyze symbols': { status: 0, stdout: '{"symbols":[]}' },
  'analyze imports': { status: 0, stdout: '{"imports":[]}' },
  'analyze boundaries': { status: 0, stdout: 'ok' },
  'analyze modules': { status: 0, stdout: 'ok' },
  'analyze ast': { status: 0, stdout: '{}' },
  'analyze deps': { status: 0, stdout: '{}' }
}

const EMPTY_BASELINE = { updatedAt: '', complexity: {}, dependencies: {} }

describe('runAllChecks', () => {
  it('passes when every check is clean', () => {
    const result = runAllChecks(execReturning(CLEAN_MAPPING), '/repo', ['src/a.ts'], EMPTY_BASELINE)
    expect(result.pass).toBe(true)
    expect(result.findings).toEqual([])
  })

  it('fails when the cycle check finds something', () => {
    const exec = execReturning({
      ...CLEAN_MAPPING,
      'check --cycles': { status: 0, stdout: '{"status":"cycles-found","cycleCount":1,"cycles":["a -> b -> a"]}' }
    })
    const result = runAllChecks(exec, '/repo', ['src/a.ts'], EMPTY_BASELINE)
    expect(result.pass).toBe(false)
    expect(result.findings.length).toBeGreaterThan(0)
  })

  it('fails when the secrets scan finds something', () => {
    const exec = execReturning({ ...CLEAN_MAPPING, 'security secrets': { status: 0, stdout: '1 secret found' } })
    const result = runAllChecks(exec, '/repo', ['src/a.ts'], EMPTY_BASELINE)
    expect(result.pass).toBe(false)
  })

  it('collects report-only output without affecting pass/fail', () => {
    const result = runAllChecks(execReturning(CLEAN_MAPPING), '/repo', ['src/a.ts'], EMPTY_BASELINE)
    expect(result.pass).toBe(true)
    expect(Object.keys(result.report)).toEqual(
      expect.arrayContaining(['symbols', 'imports', 'boundaries', 'modules', 'ast', 'deps'])
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- pre-commit-checks`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/precommit-checks/src/pre-commit-checks.ts
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Baseline, readBaseline, writeBaseline } from './lib/baseline'
import type { ExecFn } from './lib/gitnexus-checks'
import { runCycleCheck, runDetectChanges, runImpactForSymbol } from './lib/gitnexus-checks'
import {
  runComplexityRegression,
  runDependenciesRegression,
  runDiffRisk,
  runReportOnly,
  runSecretsScan
} from './lib/ruflo-checks'

const REPORT_ONLY_SUBCOMMANDS = ['symbols', 'imports', 'boundaries', 'modules', 'ast', 'deps']

export function runAllChecks(exec: ExecFn, repoRoot: string, stagedFiles: string[], baseline: Baseline) {
  const findings: string[] = []
  const warnings: string[] = []

  const record = (result: { blocking: boolean; warning: boolean; message: string }) => {
    if (result.blocking) findings.push(result.message)
    if (result.warning) warnings.push(result.message)
  }

  record(runCycleCheck(exec))

  const { result: detectChangesResult, changedSymbols } = runDetectChanges(exec)
  record(detectChangesResult)
  for (const symbol of new Set(changedSymbols)) {
    record(runImpactForSymbol(exec, symbol))
  }

  record(runDiffRisk(exec))
  record(runSecretsScan(exec))
  record(runComplexityRegression(exec, repoRoot, stagedFiles, baseline))
  record(runDependenciesRegression(exec, stagedFiles, baseline))

  const report: Record<string, unknown> = {}
  for (const subcommand of REPORT_ONLY_SUBCOMMANDS) {
    const { output } = runReportOnly(exec, subcommand)
    report[subcommand] = output
  }

  return { pass: findings.length === 0, findings, warnings, report }
}

function realExec(command: string, args: string[]) {
  try {
    const stdout = execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const execError = error as { status?: number; stdout?: string; stderr?: string }
    return { status: execError.status ?? 1, stdout: execError.stdout ?? '', stderr: execError.stderr ?? String(error) }
  }
}

function main(): void {
  const repoRoot = process.cwd()
  const stagedFiles = execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)

  const baselinePath = resolve(repoRoot, '.claude/pre-commit-baseline.json')
  const baseline = readBaseline(baselinePath)

  const { pass, findings, warnings, report } = runAllChecks(realExec, repoRoot, stagedFiles, baseline)

  writeFileSync(resolve(repoRoot, '.git/.claude-precommit-report.json'), JSON.stringify(report, null, 2))

  if (warnings.length > 0) {
    console.warn(`⚠ ${warnings.length} check(s) skipped (tool unavailable):\n${warnings.join('\n')}`)
  }

  if (!pass) {
    console.error(`✖ Pre-commit checks failed:\n${findings.join('\n')}`)
    console.log('PRECOMMIT_RESULT=FAIL')
    process.exit(1)
  }

  console.log('✔ Pre-commit checks passed.')
  console.log('PRECOMMIT_RESULT=PASS')
  process.exit(0)
}

if (existsSync('.git')) {
  main()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- pre-commit-checks`
Expected: PASS (4/4)

Note: the `if (existsSync('.git'))` top-level guard means `main()` doesn't run during `import` in tests (Vitest imports the module to get `runAllChecks`, and Vitest's cwd is the repo root, which *does* have `.git` — so also add a `process.env.VITEST` guard):

- [ ] **Step 4b: Fix the auto-run guard so tests don't trigger `main()`**

Replace the bottom guard with:

```ts
if (existsSync('.git') && !process.env.VITEST) {
  main()
}
```

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- pre-commit-checks`
Expected: PASS (4/4), and no `git diff --cached`/filesystem side effects observed during the test run.

- [ ] **Step 5: Commit**

```bash
git add packages/precommit-checks/src/pre-commit-checks.ts packages/precommit-checks/src/__tests__/pre-commit-checks.unit.ts
git commit -m "feat(precommit-checks): add main orchestrator entrypoint"
```

---

## Task 8: `claude-precommit-gate.ts` — Claude-hook-only state machine

**Files:**
- Create: `packages/precommit-checks/src/claude-precommit-gate.ts`
- Test: `packages/precommit-checks/src/__tests__/claude-precommit-gate.unit.ts`

**Interfaces:**
- Consumes: `computeDiffHash`, `readState`, `writeState`, `PrecommitState` from Task 3.
- Produces:
  - `decideGate(input: { diffHash: string; state: PrecommitState | null; runDeterministicChecks: () => { pass: boolean; findings: string[] } }): { allow: boolean; reason: string; nextState: PrecommitState }` — pure decision function (Step 3–6 of the design's flow), fully unit-testable.
  - A CLI `main()` that reads `git diff --cached`, computes the hash, calls `decideGate`, writes the resulting state, and exits `0` (allow) or `2` (deny, with `reason` on stderr — matches Claude Code's documented PreToolUse block convention).

- [ ] **Step 1: Write the failing test**

```ts
// packages/precommit-checks/src/__tests__/claude-precommit-gate.unit.ts
import { describe, expect, it, vi } from 'vitest'
import { decideGate } from '../claude-precommit-gate'

describe('decideGate', () => {
  it('reruns and denies when there is no prior state', () => {
    const runDeterministicChecks = vi.fn().mockReturnValue({ pass: false, findings: ['cycle found'] })
    const result = decideGate({ diffHash: 'h1', state: null, runDeterministicChecks })
    expect(result.allow).toBe(false)
    expect(result.reason).toContain('cycle found')
    expect(runDeterministicChecks).toHaveBeenCalledOnce()
  })

  it('reruns when the diff hash changed since the stored state', () => {
    const runDeterministicChecks = vi.fn().mockReturnValue({ pass: true, findings: [] })
    const staleState = { diffHash: 'old', deterministic: 'fail' as const, agenticReviewDone: true, overrideApproved: false }
    const result = decideGate({ diffHash: 'new', state: staleState, runDeterministicChecks })
    expect(runDeterministicChecks).toHaveBeenCalledOnce()
    expect(result.nextState.agenticReviewDone).toBe(false)
  })

  it('denies asking for review when deterministic passed but review is not done', () => {
    const runDeterministicChecks = vi.fn()
    const state = { diffHash: 'h1', deterministic: 'pass' as const, agenticReviewDone: false, overrideApproved: false }
    const result = decideGate({ diffHash: 'h1', state, runDeterministicChecks })
    expect(result.allow).toBe(false)
    expect(result.reason).toContain('code review')
    expect(runDeterministicChecks).not.toHaveBeenCalled()
  })

  it('allows when deterministic passed and review is done, for the same hash', () => {
    const state = { diffHash: 'h1', deterministic: 'pass' as const, agenticReviewDone: true, overrideApproved: false }
    const result = decideGate({ diffHash: 'h1', state, runDeterministicChecks: vi.fn() })
    expect(result.allow).toBe(true)
  })

  it('allows when overrideApproved is true, even without agenticReviewDone', () => {
    const state = { diffHash: 'h1', deterministic: 'pass' as const, agenticReviewDone: false, overrideApproved: true }
    const result = decideGate({ diffHash: 'h1', state, runDeterministicChecks: vi.fn() })
    expect(result.allow).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- claude-precommit-gate`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/precommit-checks/src/claude-precommit-gate.ts
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { computeDiffHash, type PrecommitState, readState, writeState } from './lib/precommit-state'

type DecideGateInput = {
  diffHash: string
  state: PrecommitState | null
  runDeterministicChecks: () => { pass: boolean; findings: string[] }
}

export function decideGate({ diffHash, state, runDeterministicChecks }: DecideGateInput): {
  allow: boolean
  reason: string
  nextState: PrecommitState
} {
  const isFreshForThisDiff = state?.diffHash === diffHash

  if (!isFreshForThisDiff) {
    const { pass, findings } = runDeterministicChecks()
    const nextState: PrecommitState = {
      diffHash,
      deterministic: pass ? 'pass' : 'fail',
      agenticReviewDone: false,
      overrideApproved: false
    }

    if (!pass) {
      return { allow: false, reason: `Deterministic checks failed:\n${findings.join('\n')}`, nextState }
    }

    return {
      allow: false,
      reason: 'Deterministic checks passed. Run an agentic code review over the staged diff, then call mark-review-done.',
      nextState
    }
  }

  if (state.deterministic === 'fail') {
    return { allow: false, reason: 'Deterministic checks previously failed for this diff. Fix and retry.', nextState: state }
  }

  if (state.agenticReviewDone || state.overrideApproved) {
    return { allow: true, reason: 'Gate satisfied.', nextState: state }
  }

  return {
    allow: false,
    reason: 'Deterministic checks passed. Run an agentic code review over the staged diff, then call mark-review-done.',
    nextState: state
  }
}

function main(): void {
  const repoRoot = process.cwd()
  const diffText = execFileSync('git', ['diff', '--cached'], { encoding: 'utf8' })
  const diffHash = computeDiffHash(diffText)
  const statePath = resolve(repoRoot, '.git/.claude-precommit-state.json')
  const state = readState(statePath)

  const { allow, reason, nextState } = decideGate({
    diffHash,
    state,
    runDeterministicChecks: () => {
      const result = execFileSync('npx', ['tsx', 'packages/precommit-checks/src/pre-commit-checks.ts'], {
        encoding: 'utf8'
      })
      return { pass: result.includes('PRECOMMIT_RESULT=PASS'), findings: result.includes('PRECOMMIT_RESULT=PASS') ? [] : [result] }
    }
  })

  writeState(statePath, nextState)

  if (!allow) {
    console.error(reason)
    process.exit(2)
  }

  process.exit(0)
}

if (!process.env.VITEST) {
  main()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- claude-precommit-gate`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add packages/precommit-checks/src/claude-precommit-gate.ts packages/precommit-checks/src/__tests__/claude-precommit-gate.unit.ts
git commit -m "feat(precommit-checks): add Claude-side gate state machine"
```

---

## Task 9: `mark-review-done.ts` — CLI Claude calls after the agentic review

**Files:**
- Create: `packages/precommit-checks/src/mark-review-done.ts`
- Test: `packages/precommit-checks/src/__tests__/mark-review-done.unit.ts`

**Interfaces:**
- Consumes: `computeDiffHash`, `readState`, `writeState`, `PrecommitState` (Task 3).
- Produces: `applyReviewDone(input: { diffHash: string; state: PrecommitState | null; override?: string }): PrecommitState` — pure function; throws if `state` is `null` or `state.diffHash !== diffHash` (means the deterministic gate never ran for this diff — calling this out of order is a usage error, not a silent no-op).

- [ ] **Step 1: Write the failing test**

```ts
// packages/precommit-checks/src/__tests__/mark-review-done.unit.ts
import { describe, expect, it } from 'vitest'
import { applyReviewDone } from '../mark-review-done'

describe('applyReviewDone', () => {
  const baseState = { diffHash: 'h1', deterministic: 'pass' as const, agenticReviewDone: false, overrideApproved: false }

  it('sets agenticReviewDone for the matching diff hash', () => {
    const next = applyReviewDone({ diffHash: 'h1', state: baseState })
    expect(next.agenticReviewDone).toBe(true)
    expect(next.overrideApproved).toBe(false)
  })

  it('sets overrideApproved and overrideReason when an override is given', () => {
    const next = applyReviewDone({ diffHash: 'h1', state: baseState, override: 'user confirmed, false positive' })
    expect(next.overrideApproved).toBe(true)
    expect(next.overrideReason).toBe('user confirmed, false positive')
  })

  it('throws when there is no state yet', () => {
    expect(() => applyReviewDone({ diffHash: 'h1', state: null })).toThrow(/no gate state/i)
  })

  it('throws when the diff hash does not match the stored state', () => {
    expect(() => applyReviewDone({ diffHash: 'h2', state: baseState })).toThrow(/diff has changed/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- mark-review-done`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/precommit-checks/src/mark-review-done.ts
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { computeDiffHash, type PrecommitState, readState, writeState } from './lib/precommit-state'

export function applyReviewDone(input: { diffHash: string; state: PrecommitState | null; override?: string }): PrecommitState {
  if (!input.state) throw new Error('No gate state found — run a commit attempt first so the deterministic checks run.')
  if (input.state.diffHash !== input.diffHash) {
    throw new Error('The staged diff has changed since the deterministic checks last ran — retry the commit to re-run them.')
  }

  return {
    ...input.state,
    agenticReviewDone: true,
    ...(input.override ? { overrideApproved: true, overrideReason: input.override } : {})
  }
}

function main(): void {
  const repoRoot = process.cwd()
  const overrideFlagIndex = process.argv.indexOf('--override')
  const override = overrideFlagIndex !== -1 ? process.argv[overrideFlagIndex + 1] : undefined

  const diffText = execFileSync('git', ['diff', '--cached'], { encoding: 'utf8' })
  const diffHash = computeDiffHash(diffText)
  const statePath = resolve(repoRoot, '.git/.claude-precommit-state.json')

  const nextState = applyReviewDone({ diffHash, state: readState(statePath), override })
  writeState(statePath, nextState)
  console.log(override ? `Override recorded: ${override}` : 'Agentic review recorded as done.')
}

if (!process.env.VITEST) {
  main()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/precommit-checks test:unit -- mark-review-done`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add packages/precommit-checks/src/mark-review-done.ts packages/precommit-checks/src/__tests__/mark-review-done.unit.ts
git commit -m "feat(precommit-checks): add mark-review-done CLI"
```

---

## Task 10: Wire Husky

**Files:**
- Modify: `.husky/pre-commit`

**Interfaces:**
- Consumes: `packages/precommit-checks/src/pre-commit-checks.ts` (Task 7), run via `npx tsx`.

- [ ] **Step 1: Update the hook**

Current content is just `pnpm exec lint-staged`. Change it to:

```sh
pnpm exec lint-staged
npx tsx packages/precommit-checks/src/pre-commit-checks.ts
```

- [ ] **Step 2: Verify manually**

Run: `git add -A && npx tsx packages/precommit-checks/src/pre-commit-checks.ts; echo "exit=$?"`
Expected: prints check results ending in `PRECOMMIT_RESULT=PASS` (or `FAIL` with real findings) and a matching exit code — this is the exact command Husky will run.

- [ ] **Step 3: Commit**

```bash
git add .husky/pre-commit
git commit -m "chore(husky): run pre-commit-checks after lint-staged"
```

---

## Task 11: Wire the Claude Code `PreToolUse` hook

**Files:**
- Create: `scripts/claude-git-commit-hook.cjs`
- Modify: `.claude/settings.json`

**Interfaces:**
- Consumes: `packages/precommit-checks/src/claude-precommit-gate.ts` (Task 8), run via `npx tsx`.
- Produces: a `PreToolUse` hook entry that only does work when the Bash command is a `git commit`, staying a fast no-op for every other Bash call (this hook runs before *every* Bash tool call, so the non-matching path must be cheap).

- [ ] **Step 1: Create the wrapper script**

Claude Code passes the hook event as JSON on stdin (`{"tool_name": "Bash", "tool_input": {"command": "..."}}`). This wrapper reads that, skips fast for anything that isn't `git commit`, and otherwise delegates to the gate:

```js
#!/usr/bin/env node
// scripts/claude-git-commit-hook.cjs
const { execFileSync } = require('node:child_process')

let raw = ''
process.stdin.on('data', (chunk) => {
  raw += chunk
})

process.stdin.on('end', () => {
  let command = ''
  try {
    const payload = JSON.parse(raw)
    command = payload?.tool_input?.command ?? ''
  } catch {
    process.exit(0)
  }

  if (!/(^|;|&&|\|)\s*git\s+commit\b/.test(command)) {
    process.exit(0)
  }

  try {
    execFileSync('npx', ['tsx', 'packages/precommit-checks/src/claude-precommit-gate.ts'], { stdio: 'inherit' })
    process.exit(0)
  } catch (error) {
    process.exit(error.status ?? 2)
  }
})
```

- [ ] **Step 2: Add the hook entry to `.claude/settings.json`**

Add a new object to the `PreToolUse` array (alongside the existing `Bash` matcher entry that calls `hook-handler.cjs pre-bash` — this is a **separate, additional** entry, not a replacement, so both run):

```json
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "command": "node \"${CLAUDE_PROJECT_DIR:-.}/scripts/claude-git-commit-hook.cjs\"",
      "timeout": 120000
    }
  ]
}
```

Insert it as the second element of the `PreToolUse` array (after the existing `Bash` → `pre-bash` entry, before the `Write|Edit|MultiEdit` entry).

- [ ] **Step 3: Verify manually**

Run (simulating what Claude Code sends on stdin for a non-commit command):
```bash
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | node scripts/claude-git-commit-hook.cjs; echo "exit=$?"
```
Expected: `exit=0` immediately (no gate invoked).

Run (simulating a commit attempt with nothing staged/no state file):
```bash
echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m test"}}' | node scripts/claude-git-commit-hook.cjs; echo "exit=$?"
```
Expected: `exit=2` (deterministic checks run fresh, gate denies pending agentic review — or denies on a real finding if the working tree happens to have one).

- [ ] **Step 4: Commit**

```bash
git add scripts/claude-git-commit-hook.cjs .claude/settings.json
git commit -m "feat(hooks): add Claude Code PreToolUse gate for git commit"
```

---

## Task 12: Seed the baseline and finalize docs

**Files:**
- Create: `.claude/pre-commit-baseline.json`
- Modify: `CLAUDE.md` (root) — add a line under `## Project Map` pointing at the new package and gate.

**Interfaces:**
- Consumes: `pre-commit-checks.ts`'s own baseline-writing behavior (Task 7) — running it once against the current repo state seeds the file.

- [ ] **Step 1: Generate the initial baseline**

Run: `npx tsx packages/precommit-checks/src/pre-commit-checks.ts` with something harmless staged (e.g. re-stage this plan file: `git add docs/superpowers/plans/2026-07-31-full-code-analysis-precommit-gate.md`). This populates `.claude/pre-commit-baseline.json` for the first time (empty baseline ⇒ no regressions possible ⇒ passes ⇒ baseline gets written).

Expected: `.claude/pre-commit-baseline.json` now exists with real `complexity`/`dependencies` entries for the staged file(s).

- [ ] **Step 2: Add the project-map line**

In `CLAUDE.md`, under the `## Project Map` table added in the earlier `claude-md-improver` pass, add a row:

```diff
 | `packages/message-broker` | Porta Kafka (`KafkaProducerPort`) — ainda não implementado | — |
+| `packages/precommit-checks` | Gate de análise (GitNexus+ruflo+review) antes de todo commit | [`packages/precommit-checks/CLAUDE.md`](packages/precommit-checks/CLAUDE.md) |
```

- [ ] **Step 3: Commit**

```bash
git add .claude/pre-commit-baseline.json CLAUDE.md
git commit -m "chore(precommit-checks): seed baseline and document in project map"
```

---

## Task 13: End-to-end manual verification

Not automated — run through this checklist by hand once Tasks 1–12 are done, per the spec's test plan:

- [ ] **Scenario 1 — Husky blocks a real cycle:** In a scratch branch, reintroduce an import cycle (e.g. temporarily make `packages/precommit-checks/src/lib/extract-json.ts` import something that imports it back), `git add`, `git commit -m test`. Expected: Husky's `pre-commit-checks.mjs` step fails, commit is rejected. Revert the cycle.
- [ ] **Scenario 2 — clean commit passes both sides:** Make a trivial doc-only change, stage it, commit normally. Expected: passes.
- [ ] **Scenario 3 — Claude-side review gate:** As Claude, attempt `git commit` on a real change. Expected: hook denies (exit 2) with "run an agentic code review" reason; after running a review agent and calling `mark-review-done.ts`, retry succeeds.
- [ ] **Scenario 4 — review finding stops the flow:** Force the review agent to report a finding (e.g. review a diff with an obvious issue). Expected: Claude stops and asks the user before doing anything else — confirmed by reading the transcript, not automatable.
- [ ] **Scenario 5 — explicit override:** With a pending finding, user says "commit anyway" — Claude runs `mark-review-done.ts --override "<reason>"`, retries, commit succeeds.

- [ ] **Final step: update the design spec's status line** from "Aprovado para plano de implementação" to "Implementado" in `docs/superpowers/specs/2026-07-31-full-code-analysis-precommit-gate-design.md`, commit.
