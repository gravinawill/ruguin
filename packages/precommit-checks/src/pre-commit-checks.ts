import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Baseline, readBaseline } from './lib/baseline'
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

if (existsSync('.git') && !process.env.VITEST) {
  main()
}
