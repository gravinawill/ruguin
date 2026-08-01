import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { realExec, resolveGitDirectory } from './lib/git'
import { computeDiffHash, type PrecommitState, readState, writeState } from './lib/precommit-state'

/*
 * Kept comfortably under the PreToolUse hook's own 150000ms timeout (`.claude/settings.json`).
 * Measured real runs of `pre-commit-checks.ts` take ~100-150s; without an explicit bound here,
 * a slow run could hit Claude Code's own hook timeout FIRST — from Claude Code's side, not this
 * process's — which kills this script before `writeState` ever runs. No state is persisted, so
 * the next attempt reruns the entire ~150s check suite from scratch: a livelock, not a clean
 * failure. This timeout gives this script a chance to fail cleanly (and persist state) before
 * that outer timeout can fire.
 */
const DETERMINISTIC_CHECKS_TIMEOUT_MS = 140_000
/*
 * Matches `realExec`'s own maxBuffer (see `./lib/git`) — `pre-commit-checks.ts` can produce a
 * large report (report-only subcommands over a big diff), same rationale applies here.
 */
const DETERMINISTIC_CHECKS_MAX_BUFFER_BYTES = 64 * 1024 * 1024

type DecideGateInput = {
  diffHash: string
  state: PrecommitState | null
  runDeterministicChecks: () => { pass: boolean; findings: string[]; diffHashAfterChecks: string }
}

export function decideGate({ diffHash, state, runDeterministicChecks }: DecideGateInput): {
  allow: boolean
  reason: string
  nextState: PrecommitState
} {
  const isFreshForThisDiff = state?.diffHash === diffHash

  if (!isFreshForThisDiff) {
    /*
     * `diffHashAfterChecks` (not the outer `diffHash` param) is what gets persisted below.
     * Running the deterministic checks can itself mutate the staged diff — e.g.
     * `pre-commit-checks.ts`'s own `main()` runs `git add` on an updated baseline file when
     * its checks pass — so the hash captured before calling `runDeterministicChecks()` can be
     * stale by the time this function returns. Persisting the pre-check hash caused
     * `mark-review-done.ts` (which independently recomputes its own fresh hash from the
     * CURRENT `git diff --cached`) to see a permanent mismatch and reject every review,
     * even when nothing the user/Claude did actually changed. `diffHash` itself is still used
     * above, unmodified, purely to detect staleness against the *previous* run's already
     * post-check hash — that comparison is unaffected by this run's own side effects.
     */
    const { pass, findings, diffHashAfterChecks } = runDeterministicChecks()
    const nextState: PrecommitState = {
      diffHash: diffHashAfterChecks,
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

  /*
   * `overrideApproved` is checked BEFORE `state.deterministic`, so an approved override can
   * unblock either a deterministic failure or a pending agentic review — "zero-tolerance: ANY
   * finding blocks, but an explicit user-confirmed override unblocks it" applies universally,
   * not only to the pending-review state. `mark-review-done.ts --override "<reason>"` already
   * allows setting `overrideApproved: true` regardless of `state.deterministic`, so this check
   * must honor it regardless too, or the override could never actually take effect on a
   * deterministic failure.
   */
  if (state.overrideApproved) {
    return { allow: true, reason: 'Gate satisfied (override approved).', nextState: state }
  }

  if (state.deterministic === 'fail') {
    return {
      allow: false,
      reason: 'Deterministic checks previously failed for this diff. Fix and retry.',
      nextState: state
    }
  }

  /*
   * You can't "review" a change that failed deterministic checks — only override past it — so
   * `agenticReviewDone` is only meaningful once `state.deterministic === 'pass'`, reached here.
   */
  if (state.agenticReviewDone) {
    return { allow: true, reason: 'Gate satisfied.', nextState: state }
  }

  return {
    allow: false,
    reason: 'Deterministic checks passed. Run an agentic code review over the staged diff, then call mark-review-done.',
    nextState: state
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
 * `realExec` (see `./lib/git`), so both the pass and fail paths are handled without an
 * uncaught exception crashing this script.
 *
 * Also recomputes and returns `diffHashAfterChecks`: `pre-commit-checks.ts`'s own `main()`
 * stages an updated `.claude/pre-commit-baseline.json` via `git add` when its checks pass,
 * mutating `git diff --cached` as a side effect of this very call. Recomputed unconditionally
 * (not only on pass) so this stays correct even if a future change adds a side effect on the
 * failure path too.
 */
export function runDeterministicChecksSubprocess(): {
  pass: boolean
  findings: string[]
  diffHashAfterChecks: string
} {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
  const preCommitChecksPath = path.resolve(currentDirectory, 'pre-commit-checks.ts')

  const result = ((): { pass: boolean; findings: string[] } => {
    try {
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- `npx`/`tsx` resolve via PATH by design; trusted, well-known project tooling, not user input.
      const stdout = execFileSync('npx', ['tsx', preCommitChecksPath], {
        encoding: 'utf8',
        timeout: DETERMINISTIC_CHECKS_TIMEOUT_MS,
        maxBuffer: DETERMINISTIC_CHECKS_MAX_BUFFER_BYTES
      })
      return { pass: stdout.includes('PRECOMMIT_RESULT=PASS'), findings: [] }
    } catch (error) {
      const execError = error as { stdout?: string; stderr?: string; signal?: string | null; code?: string }
      /*
       * stderr carries the actual `✖ Pre-commit checks failed:\n<findings>` text (see
       * pre-commit-checks.ts's `console.error`); stdout only carries the PRECOMMIT_RESULT
       * marker. Both are included so nothing useful is dropped, with String(error) as an
       * ultimate fallback for the (unexpected) case where the child process produced neither.
       *
       * When `execFileSync`'s `timeout` kills the process, stdout/stderr are typically empty
       * (the process was killed mid-run, before it could flush a useful report) and Node
       * surfaces `signal: 'SIGTERM'` + `code: 'ETIMEDOUT'` instead of a normal exit — that
       * combination is treated as a failure like any other (`pass: false`), just with a clearer
       * message than the raw `Error: spawnSync npx ETIMEDOUT` would otherwise produce.
       */
      const isTimedOut = execError.code === 'ETIMEDOUT' && execError.signal === 'SIGTERM'
      const output = [execError.stdout, execError.stderr].filter(Boolean).join('\n') || String(error)
      return {
        pass: false,
        findings: [
          isTimedOut ? `Deterministic checks timed out after ${DETERMINISTIC_CHECKS_TIMEOUT_MS}ms.\n${output}` : output
        ]
      }
    }
  })()

  // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` resolves via PATH by design; trusted, well-known project tool, not user input.
  const diffTextAfterChecks = execFileSync('git', ['diff', '--cached'], { encoding: 'utf8' })

  return { ...result, diffHashAfterChecks: computeDiffHash(diffTextAfterChecks) }
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
