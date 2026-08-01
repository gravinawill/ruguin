import type { ExecFn, ExecResult } from './gitnexus-checks'

import { execFileSync } from 'node:child_process'
import path from 'node:path'

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * The one real implementation of `ExecFn`, used by every check function in this package.
 * Every subprocess call is bounded by `timeoutMs` so a hung or pathologically slow tool
 * (e.g. `ruflo analyze boundaries` walking an inflated dependency graph across multiple git
 * worktrees) degrades to a warning instead of hanging the whole script forever.
 *
 * When `execFileSync`'s `timeout` kills the process, Node throws an error with `status: null`
 * and a `signal` (e.g. `'SIGTERM'`) instead of a normal exit code — `execError.status ?? 1`
 * below maps that `null` to `1` via nullish coalescing, so a timeout is reported the same way
 * as any other non-zero exit: a `{ status: 1, ... }` result, never a thrown/hanging failure.
 *
 * `timeoutMs` is an optional third parameter (default `DEFAULT_TIMEOUT_MS`) purely for test
 * injection — `realExec` is still assignable everywhere an `ExecFn` is expected, since a
 * function with an extra optional parameter satisfies a shorter function type.
 */
export function realExec(command: string, arguments_: string[], timeoutMs = DEFAULT_TIMEOUT_MS): ExecResult {
  try {
    const stdout = execFileSync(command, arguments_, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const execError = error as { status?: number | null; stdout?: string; stderr?: string }
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
 *
 * `status` is checked explicitly rather than trusting `stdout` alone: if this `git` call ever
 * fails, `stdout` would be `''` and `path.resolve(repoRoot, '')` would silently return
 * `repoRoot` itself — meaning the gate state file and the report file would land directly in
 * the repo root as untracked files instead of inside the real git directory, where a broad
 * `git add` could accidentally sweep them into a real commit. This is an infrastructure
 * problem, not a "wrong path" the caller can gracefully degrade around, so it throws.
 */
export function resolveGitDirectory(exec: ExecFn, repoRoot: string): string {
  const { status, stdout, stderr } = exec('git', ['rev-parse', '--git-dir'])
  if (status !== 0) {
    throw new Error(`git rev-parse --git-dir failed (status ${status}): ${stderr || 'no output'}`)
  }
  return path.resolve(repoRoot, stdout.trim())
}
