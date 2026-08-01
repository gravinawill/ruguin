import type { CheckResult, ExecFn } from './gitnexus-checks'

import path from 'node:path'

import { type Baseline, complexityRegressed, dependenciesRegressed } from './baseline'
import { extractJson } from './extract-json'

const RUFLO = 'npx'
/*
 * Pinned (not `@latest`) so every invocation doesn't re-resolve the tag against the npm
 * registry — matches the latest published version as of this pin (2026-08-01); bump
 * deliberately, not silently on every run.
 */
const RUFLO_ARGS_PREFIX = ['@claude-flow/cli@3.34.0']
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

type SecretFinding = { type: string; file: string; line: number; risk: string }

/**
 * Parses the plain-text table `ruflo security secrets` prints (it has no `--format json`
 * support — confirmed: the flag is silently ignored). Shape (confirmed empirically against a
 * real scan):
 *
 * ```
 * +----------------+-------------------+----------+--------------------+
 * | Secret Type    | Location          | Risk     | Recommended        |
 * +----------------+-------------------+----------+--------------------+
 * | AWS Access Key | src/sub/deep.ts:2 | Critical | Rotate immediately |
 * +----------------+-------------------+----------+--------------------+
 * ```
 *
 * `Location` is `<path relative to the scanned directory>:<1-based line>`. The trailing
 * "Secrets Summary" box uses the same `|...|` border style but is single-column
 * (e.g. `| Files scanned: N |`), so it's naturally excluded below by requiring exactly 4 cells.
 */
function parseSecretsTable(stdout: string): SecretFinding[] {
  const findings: SecretFinding[] = []

  for (const line of stdout.split('\n')) {
    const trimmedLine = line.trim()
    if (!trimmedLine.startsWith('|') || !trimmedLine.endsWith('|')) continue

    const cells = trimmedLine
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim())
    if (cells.length !== 4) continue

    const [type, location, risk] = cells
    if (type === undefined || location === undefined || risk === undefined || type === 'Secret Type') continue

    const lastColonIndex = location.lastIndexOf(':')
    if (lastColonIndex === -1) continue

    const file = location.slice(0, lastColonIndex)
    const lineText = location.slice(lastColonIndex + 1)
    const lineNumber = Number(lineText)
    // `Number('')` is `0`, not `NaN` — checked separately so a trailing bare `:` doesn't parse as line 0.
    if (!file || !lineText || Number.isNaN(lineNumber)) continue

    findings.push({ type, file, line: lineNumber, risk })
  }

  return findings
}

export function runSecretsScan(exec: ExecFn, repoRoot: string, stagedFiles: string[]): CheckResult {
  // If there are no staged files, nothing to scan
  if (stagedFiles.length === 0) {
    return { blocking: false, warning: false, message: 'No staged files to scan for secrets.' }
  }

  /*
   * The CLI's `-p` flag only accepts a DIRECTORY, not a file — passing an individual file path
   * silently scans 0 files and reports clean (confirmed empirically: `-p <file>` reports
   * "Scanned 0 files" / "No secrets detected." even for a file containing an obvious secret;
   * `-p <dir>` containing that same file reports "Scanned N files" and correctly finds it). So
   * staged files are grouped by their containing directory (deduplicated — several staged files
   * sharing a directory scan it once, not once per file), and each directory's reported findings
   * are filtered down to only the ones whose Location corresponds to an actually-staged file —
   * preserving the original design intent (don't block on a pre-existing secret elsewhere in a
   * shared directory) while the scan itself actually runs.
   */
  const directories = new Set(stagedFiles.map((file) => path.dirname(path.resolve(repoRoot, file))))
  const stagedAbsolutePaths = new Set(stagedFiles.map((file) => path.resolve(repoRoot, file)))

  const allMessages: string[] = []
  let hasSecrets = false
  let hasErrors = false

  for (const directory of directories) {
    const { stdout, stderr } = exec(RUFLO, [
      ...RUFLO_ARGS_PREFIX,
      'security',
      'secrets',
      '--action',
      'scan',
      '-p',
      directory
    ])

    /*
     * The tool exits 1 whenever ANY secret is found (not only on a genuine tool failure) and
     * has no JSON output to lean on, so exit status alone can't distinguish "secrets found"
     * from "tool unavailable". The "Scanned N files" line the tool always prints on a real run
     * is used as the availability signal instead.
     */
    if (!/Scanned \d+ files?/i.test(stdout)) {
      hasErrors = true
      allMessages.push(`⚠ Unable to scan ${directory}: ${stderr || 'no output'}`)
      continue
    }

    const relevantFindings = parseSecretsTable(stdout).filter((finding) =>
      stagedAbsolutePaths.has(path.resolve(directory, finding.file))
    )

    if (relevantFindings.length > 0) {
      hasSecrets = true
      allMessages.push(
        `Found secrets in ${directory}:\n${relevantFindings
          .map((finding) => `${finding.type} at ${finding.file}:${finding.line} (${finding.risk})`)
          .join('\n')}`
      )
    }
  }

  // Block if any secrets found; warn if any scan failed; else clean pass
  if (hasSecrets) {
    return { blocking: true, warning: false, message: allMessages.join('\n\n') }
  }

  if (hasErrors) {
    return { blocking: false, warning: true, message: allMessages.join('\n\n') }
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
