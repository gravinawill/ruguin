import type { CheckResult, ExecFn } from './gitnexus-checks'

import path from 'node:path'

import { type Baseline, complexityRegressed, dependenciesRegressed } from './baseline'
import { extractJson } from './extract-json'

const RUFLO = 'npx'
const RUFLO_ARGS_PREFIX = ['@claude-flow/cli@latest']
const BLOCKING_RISK = new Set(['medium', 'high', 'critical'])

export function runDiffRisk(exec: ExecFn): CheckResult {
  const { status, stdout, stderr } = exec(RUFLO, [
    ...RUFLO_ARGS_PREFIX,
    'analyze',
    'diff',
    '--risk',
    '--format',
    'json'
  ])

  const parsed = extractJson(stdout) as { risk?: { overall?: string } } | null
  if (status !== 0 || !parsed) {
    return {
      blocking: false,
      warning: true,
      message: `ruflo analyze diff --risk unavailable: ${stderr || 'no output'}`
    }
  }

  const overall = (parsed.risk?.overall ?? 'low').toLowerCase()
  return { blocking: BLOCKING_RISK.has(overall) && overall !== 'low', warning: false, message: `diff risk: ${overall}` }
}

export function runSecretsScan(exec: ExecFn): CheckResult {
  const { status, stdout, stderr } = exec(RUFLO, [
    ...RUFLO_ARGS_PREFIX,
    'security',
    'secrets',
    '--action',
    'scan',
    '-p',
    '.'
  ])

  if (status !== 0 && !stdout) {
    return { blocking: false, warning: true, message: `ruflo security secrets unavailable: ${stderr || 'no output'}` }
  }

  const isClean = stdout.includes('No secrets detected.')
  return { blocking: !isClean, warning: false, message: isClean ? 'No secrets detected.' : stdout.trim() }
}

export function runComplexityRegression(
  exec: ExecFn,
  repoRoot: string,
  stagedFiles: string[],
  baseline: Baseline
): CheckResult {
  const { status, stdout, stderr } = exec(RUFLO, [...RUFLO_ARGS_PREFIX, 'analyze', 'complexity', '--format', 'json'])

  const parsed = extractJson(stdout) as {
    files?: Array<{ file: string; cyclomatic: number; cognitive: number }>
  } | null
  if (status !== 0 || !parsed) {
    return { blocking: false, warning: true, message: `ruflo analyze complexity unavailable: ${stderr || 'no output'}` }
  }

  const byAbsolutePath = new Map((parsed.files ?? []).map((entry) => [entry.file, entry]))
  const regressions = stagedFiles.filter((relativePath) => {
    const entry = byAbsolutePath.get(path.resolve(repoRoot, relativePath))
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

  const parsed = extractJson(stdout) as { edges?: Array<{ source: string; target: string }> } | null
  if (status !== 0 || !parsed) {
    return {
      blocking: false,
      warning: true,
      message: `ruflo analyze dependencies unavailable: ${stderr || 'no output'}`
    }
  }

  const edges = parsed.edges ?? []
  const regressions = stagedFiles.filter((relativePath) => {
    const connections = edges.filter((edge) => edge.source === relativePath || edge.target === relativePath).length
    return dependenciesRegressed(baseline, relativePath, { connections })
  })

  return {
    blocking: regressions.length > 0,
    warning: false,
    message:
      regressions.length > 0 ? `Dependency count regressed in: ${regressions.join(', ')}` : 'No dependency regression.'
  }
}

export function runReportOnly(exec: ExecFn, subcommand: string): { subcommand: string; output: unknown } {
  const { stdout } = exec(RUFLO, [...RUFLO_ARGS_PREFIX, 'analyze', subcommand, '--format', 'json'])

  const parsed = extractJson(stdout)
  return { subcommand, output: parsed ?? stdout.trim() }
}
