import type { ExecFn } from './lib/gitnexus-checks'

import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { type Baseline, readBaseline, writeBaseline } from './lib/baseline'
import { realExec, resolveGitDirectory } from './lib/git'
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
  const uniqueChangedSymbols = new Set(changedSymbols)
  for (const symbol of uniqueChangedSymbols) {
    record(runImpactForSymbol(exec, symbol))
  }

  record(runDiffRisk(exec))
  record(runSecretsScan(exec, stagedFiles))

  const complexityResult = runComplexityRegression(exec, repoRoot, stagedFiles, baseline)
  record(complexityResult)

  const dependenciesResult = runDependenciesRegression(exec, stagedFiles, baseline)
  record(dependenciesResult)

  const report: Record<string, unknown> = {}
  for (const subcommand of REPORT_ONLY_SUBCOMMANDS) {
    const { output } = runReportOnly(exec, subcommand)
    report[subcommand] = output
  }

  const currentMetrics = {
    complexity: complexityResult.currentComplexity,
    dependencies: dependenciesResult.currentDependencies
  }

  return { pass: findings.length === 0, findings, warnings, report, currentMetrics }
}

function main(): void {
  const repoRoot = process.cwd()

  // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` resolves via PATH by design; trusted, well-known project tool, not user input.
  const stagedFiles = execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)

  const gitDirectory = resolveGitDirectory(realExec, repoRoot)

  const baselinePath = path.resolve(repoRoot, '.claude/pre-commit-baseline.json')
  const baseline = readBaseline(baselinePath)

  const { pass, findings, warnings, report, currentMetrics } = runAllChecks(realExec, repoRoot, stagedFiles, baseline)

  if (pass) {
    const updatedBaseline: Baseline = {
      updatedAt: new Date().toISOString(),
      complexity: { ...baseline.complexity, ...currentMetrics.complexity },
      dependencies: { ...baseline.dependencies, ...currentMetrics.dependencies }
    }
    writeBaseline(baselinePath, updatedBaseline)
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` resolves via PATH by design; trusted, well-known project tool, not user input.
    execFileSync('git', ['add', baselinePath])
  }

  writeFileSync(path.resolve(gitDirectory, '.claude-precommit-report.json'), JSON.stringify(report, null, 2))

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

/*
 * `runAllChecks` is exported from this module for other files (and tests) to import. Without
 * this check, evaluating that import would also run the guard below purely as a side effect of
 * module evaluation (ESM top-level code runs once on first import, regardless of who imports
 * it) — triggering this file's own `main()` and `process.exit()` before the importer's own
 * logic ever gets a chance to run. Comparing `import.meta.url` against `process.argv[1]`
 * restricts the auto-run to only when this file is the directly-executed entrypoint (e.g. via
 * `npx tsx src/pre-commit-checks.ts` from Husky), not merely imported for its exports.
 */
const isDirectlyExecuted = process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

if (isDirectlyExecuted && existsSync('.git') && !process.env.VITEST) {
  main()
}
