import type { ExecFn, ExecResult } from './gitnexus-checks'

import { execFileSync } from 'node:child_process'
import path from 'node:path'

export function realExec(command: string, arguments_: string[]): ExecResult {
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
