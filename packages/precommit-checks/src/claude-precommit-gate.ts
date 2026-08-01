import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { computeDiffHash, type PrecommitState, readState, writeState } from './lib/precommit-state'
import { resolveGitDirectory } from './pre-commit-checks'

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
      reason:
        'Deterministic checks passed. Run an agentic code review over the staged diff, then call mark-review-done.',
      nextState
    }
  }

  if (state.deterministic === 'fail') {
    return {
      allow: false,
      reason: 'Deterministic checks previously failed for this diff. Fix and retry.',
      nextState: state
    }
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
 * Runs `pre-commit-checks.ts` as a subprocess and interprets its `PRECOMMIT_RESULT=PASS|FAIL`
 * marker line. Resolved via `import.meta.url` (a sibling of this file) rather than a path
 * relative to `process.cwd()`, so it works regardless of the cwd the Claude PreToolUse hook
 * happens to invoke this script from — it doesn't have to be the repo root.
 *
 * `execFileSync` throws when the child process exits non-zero (which `pre-commit-checks.ts`
 * does on any blocking finding) — the thrown error still carries `stdout`/`stderr`, same as
 * `realExec` above, so both the pass and fail paths are handled without an uncaught exception
 * crashing this script.
 */
function runDeterministicChecksSubprocess(): { pass: boolean; findings: string[] } {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
  const preCommitChecksPath = path.resolve(currentDirectory, 'pre-commit-checks.ts')

  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- `npx`/`tsx` resolve via PATH by design; trusted, well-known project tooling, not user input.
    const stdout = execFileSync('npx', ['tsx', preCommitChecksPath], { encoding: 'utf8' })
    return { pass: stdout.includes('PRECOMMIT_RESULT=PASS'), findings: [] }
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string }
    /*
     * stderr carries the actual `✖ Pre-commit checks failed:\n<findings>` text (see
     * pre-commit-checks.ts's `console.error`); stdout only carries the PRECOMMIT_RESULT marker.
     * Both are included so nothing useful is dropped, with String(error) as an ultimate fallback
     * for the (unexpected) case where the child process produced neither.
     */
    const output = [execError.stdout, execError.stderr].filter(Boolean).join('\n') || String(error)
    return { pass: false, findings: [output] }
  }
}

function main(): void {
  const repoRoot = process.cwd()
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` resolves via PATH by design; trusted, well-known project tool, not user input.
  const diffText = execFileSync('git', ['diff', '--cached'], { encoding: 'utf8' })
  const diffHash = computeDiffHash(diffText)

  const gitDirectory = resolveGitDirectory(realExec, repoRoot)
  const statePath = path.resolve(gitDirectory, '.claude-precommit-state.json')
  const state = readState(statePath)

  const { allow, reason, nextState } = decideGate({
    diffHash,
    state,
    runDeterministicChecks: runDeterministicChecksSubprocess
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
