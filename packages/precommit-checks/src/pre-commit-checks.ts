import type { ExecFn } from './lib/gitnexus-checks'

import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { type Baseline, readBaseline, writeBaseline } from './lib/baseline'
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

function realExec(command: string, arguments_: string[]) {
  try {
    const stdout = execFileSync(command, arguments_, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const execError = error as { status?: number; stdout?: string; stderr?: string }
    return { status: execError.status ?? 1, stdout: execError.stdout ?? '', stderr: execError.stderr ?? String(error) }
  }
}

/**
 * Resolves the real git directory via `git rev-parse --git-dir`, instead of assuming
 * `<repoRoot>/.git` is always a directory. Inside a git worktree, `.git` is a plain text
 * pointer file (not a directory), so writing to `resolve(repoRoot, '.git/...')` throws
 * ENOTDIR. `git rev-parse --git-dir` returns the correct path in both cases — e.g.
 * `/main-repo/.git/worktrees/<name>` for a worktree — and per git's own docs/behavior it
 * may be relative to the cwd it was invoked from, so it's resolved against `repoRoot` here
 * (a no-op when the returned path is already absolute, since `path.resolve` discards
 * earlier segments once it hits an absolute one).
 */
export function resolveGitDirectory(exec: ExecFn, repoRoot: string): string {
  const { stdout } = exec('git', ['rev-parse', '--git-dir'])
  return path.resolve(repoRoot, stdout.trim())
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

if (existsSync('.git') && !process.env.VITEST) {
  main()
}
