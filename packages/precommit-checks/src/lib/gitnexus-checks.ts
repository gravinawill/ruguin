import { extractJson } from './extract-json'

export type ExecResult = { status: number; stdout: string; stderr: string }
export type ExecFn = (command: string, arguments_: string[]) => ExecResult
export type CheckResult = { blocking: boolean; warning: boolean; message: string }

const BLOCKING_RISK_LEVELS = new Set(['HIGH', 'CRITICAL'])

/*
 * All three GitNexus commands below take a `-r/--repo <name>` flag. It's threaded through from
 * `repoRoot` (an absolute path) rather than hardcoded, because a machine with more than one
 * GitNexus-indexed repo sharing the same package name (e.g. a main checkout plus one or more
 * worktrees of it — common in this very codebase) makes `.gitnexus/run.cjs` fail every one of
 * these calls with "Multiple repositories indexed. Specify which one with the 'repo' parameter"
 * and silently degrade to a warning — meaning these checks never actually run in that (common)
 * setup. Confirmed empirically that passing the exact absolute repo path (as listed by
 * `node .gitnexus/run.cjs list`) resolves the ambiguity unambiguously; a bare basename does NOT
 * work reliably (GitNexus indexes repos by package name, not directory name, so two worktrees
 * of the same package still collide on a basename-derived value).
 */
export function runCycleCheck(exec: ExecFn, repoRoot: string): CheckResult {
  const { status, stdout, stderr } = exec('node', ['.gitnexus/run.cjs', 'check', '--cycles', '--json', '-r', repoRoot])

  const parsed = extractJson(stdout) as { status?: string; cycleCount?: number; cycles?: string[] } | null
  if (status !== 0 || !parsed) {
    return { blocking: false, warning: true, message: `gitnexus check --cycles unavailable: ${stderr || 'no output'}` }
  }

  if ((parsed.cycleCount ?? 0) > 0) {
    return { blocking: true, warning: false, message: `Import cycle(s) found:\n${(parsed.cycles ?? []).join('\n')}` }
  }

  return { blocking: false, warning: false, message: 'No circular imports found.' }
}

export function runDetectChanges(exec: ExecFn, repoRoot: string): { result: CheckResult; changedSymbols: string[] } {
  const { status, stdout, stderr } = exec('node', [
    '.gitnexus/run.cjs',
    'detect-changes',
    '--scope',
    'staged',
    '-r',
    repoRoot
  ])

  if (status !== 0) {
    return {
      result: {
        blocking: false,
        warning: true,
        message: `gitnexus detect-changes unavailable: ${stderr || 'no output'}`
      },
      changedSymbols: []
    }
  }

  const riskMatch = /Risk level:\s*(\w+)/i.exec(stdout)
  const risk = (riskMatch?.[1] ?? 'unknown').toUpperCase()

  /*
   * Plain string parsing (no regex) for lines shaped like "  Symbol Name → path" —
   * simpler than a regex here and sidesteps backtracking concerns entirely.
   */
  const changedSymbols: string[] = []
  for (const line of stdout.split('\n')) {
    const trimmedLine = line.trim()
    if (!trimmedLine.startsWith('Symbol ')) continue

    const arrowIndex = trimmedLine.indexOf(' → ')
    if (arrowIndex === -1) continue

    const symbol = trimmedLine.slice('Symbol '.length, arrowIndex).trim()
    if (symbol) changedSymbols.push(symbol)
  }

  const isBlocking = BLOCKING_RISK_LEVELS.has(risk)
  return {
    result: { blocking: isBlocking, warning: false, message: `detect-changes risk level: ${risk}` },
    changedSymbols
  }
}

export function runImpactForSymbol(exec: ExecFn, symbol: string, repoRoot: string): CheckResult {
  const { status, stdout, stderr } = exec('node', [
    '.gitnexus/run.cjs',
    'impact',
    symbol,
    '-d',
    'upstream',
    '--summary-only',
    '-r',
    repoRoot
  ])

  const parsed = extractJson(stdout) as { risk?: string } | null
  if (status !== 0 || !parsed) {
    return {
      blocking: false,
      warning: true,
      message: `gitnexus impact "${symbol}" unavailable: ${stderr || 'no output'}`
    }
  }

  const risk = (parsed.risk ?? 'UNKNOWN').toUpperCase()
  return {
    blocking: BLOCKING_RISK_LEVELS.has(risk),
    warning: false,
    message: `impact "${symbol}": risk ${risk}`
  }
}
