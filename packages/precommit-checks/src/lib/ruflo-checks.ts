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

export function runSecretsScan(exec: ExecFn, stagedFiles: string[]): CheckResult {
  // If there are no staged files, nothing to scan
  if (stagedFiles.length === 0) {
    return { blocking: false, warning: false, message: 'No staged files to scan for secrets.' }
  }

  const allMessages: string[] = []
  let hasSecrets = false

  // Scan each staged file individually to avoid detecting pre-existing repo-wide secrets
  for (const file of stagedFiles) {
    const { status, stdout, stderr } = exec(RUFLO, [
      ...RUFLO_ARGS_PREFIX,
      'security',
      'secrets',
      '--action',
      'scan',
      '-p',
      file
    ])

    if (status !== 0 && !stdout) {
      // Tool unavailable, but don't block on this single file — continue scanning others
      allMessages.push(`⚠ Unable to scan ${file}: ${stderr || 'no output'}`)
      continue
    }

    const isClean = stdout.includes('No secrets detected.')
    if (!isClean) {
      hasSecrets = true
      allMessages.push(`Found secrets in ${file}:\n${stdout.trim()}`)
    }
  }

  if (hasSecrets) {
    return { blocking: true, warning: false, message: allMessages.join('\n\n') }
  }

  return { blocking: false, warning: false, message: 'No secrets detected.' }
}

export type ComplexityCheckResult = CheckResult & {
  currentComplexity: Record<string, { cyclomatic: number; cognitive: number }>
}

export type DependenciesCheckResult = CheckResult & {
  currentDependencies: Record<string, { connections: number }>
}

export function runComplexityRegression(
  exec: ExecFn,
  repoRoot: string,
  stagedFiles: string[],
  baseline: Baseline
): ComplexityCheckResult {
  const { status, stdout, stderr } = exec(RUFLO, [...RUFLO_ARGS_PREFIX, 'analyze', 'complexity', '--format', 'json'])

  const parsed = extractJson(stdout) as {
    files?: Array<{ file: string; cyclomatic: number; cognitive: number }>
  } | null
  if (status !== 0 || !parsed) {
    return {
      blocking: false,
      warning: true,
      message: `ruflo analyze complexity unavailable: ${stderr || 'no output'}`,
      currentComplexity: {}
    }
  }

  const byAbsolutePath = new Map((parsed.files ?? []).map((entry) => [entry.file, entry]))

  const currentComplexity: Record<string, { cyclomatic: number; cognitive: number }> = {}
  for (const relativePath of stagedFiles) {
    const entry = byAbsolutePath.get(path.resolve(repoRoot, relativePath))
    if (entry) currentComplexity[relativePath] = { cyclomatic: entry.cyclomatic, cognitive: entry.cognitive }
  }

  const regressions = stagedFiles.filter((relativePath) => {
    const entry = byAbsolutePath.get(path.resolve(repoRoot, relativePath))
    if (!entry) return false
    return complexityRegressed(baseline, relativePath, { cyclomatic: entry.cyclomatic, cognitive: entry.cognitive })
  })

  return {
    blocking: regressions.length > 0,
    warning: false,
    message:
      regressions.length > 0 ? `Complexity regressed in: ${regressions.join(', ')}` : 'No complexity regression.',
    currentComplexity
  }
}

export function runDependenciesRegression(
  exec: ExecFn,
  stagedFiles: string[],
  baseline: Baseline
): DependenciesCheckResult {
  const { status, stdout, stderr } = exec(RUFLO, [...RUFLO_ARGS_PREFIX, 'analyze', 'dependencies', '--format', 'json'])

  const parsed = extractJson(stdout) as { edges?: Array<{ source: string; target: string }> } | null
  if (status !== 0 || !parsed) {
    return {
      blocking: false,
      warning: true,
      message: `ruflo analyze dependencies unavailable: ${stderr || 'no output'}`,
      currentDependencies: {}
    }
  }

  const edges = parsed.edges ?? []

  const currentDependencies: Record<string, { connections: number }> = {}
  for (const relativePath of stagedFiles) {
    const connections = edges.filter((edge) => edge.source === relativePath || edge.target === relativePath).length
    currentDependencies[relativePath] = { connections }
  }

  const regressions = stagedFiles.filter((relativePath) =>
    dependenciesRegressed(baseline, relativePath, currentDependencies[relativePath] ?? { connections: 0 })
  )

  return {
    blocking: regressions.length > 0,
    warning: false,
    message:
      regressions.length > 0 ? `Dependency count regressed in: ${regressions.join(', ')}` : 'No dependency regression.',
    currentDependencies
  }
}

export function runReportOnly(exec: ExecFn, subcommand: string): { subcommand: string; output: unknown } {
  const { stdout } = exec(RUFLO, [...RUFLO_ARGS_PREFIX, 'analyze', subcommand, '--format', 'json'])

  const parsed = extractJson(stdout)
  return { subcommand, output: parsed ?? stdout.trim() }
}
