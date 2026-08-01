import { describe, expect, it, vi } from 'vitest'

import { realExec, resolveGitDirectory } from '../git'

describe('realExec', () => {
  it('returns a { status: 1, ... } result instead of hanging or throwing when the subprocess exceeds the timeout', () => {
    const start = Date.now()
    const result = realExec('node', ['-e', 'setTimeout(() => {}, 10000)'], 500)
    const elapsedMs = Date.now() - start

    expect(result.status).toBe(1)
    expect(typeof result.stdout).toBe('string')
    expect(typeof result.stderr).toBe('string')
    // Should return promptly once killed by the timeout, well short of the 10s the subprocess sleeps for.
    expect(elapsedMs).toBeLessThan(5000)
  })
})

describe('resolveGitDirectory', () => {
  it('returns an absolute git-dir path unchanged (e.g. a worktree pointing outside repoRoot)', () => {
    const exec = vi.fn().mockReturnValue({
      status: 0,
      stdout: '/main-repo/.git/worktrees/my-worktree\n',
      stderr: ''
    })
    expect(resolveGitDirectory(exec, '/repo')).toBe('/main-repo/.git/worktrees/my-worktree')
  })

  it('resolves a relative git-dir path against repoRoot (normal checkout)', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '.git\n', stderr: '' })
    expect(resolveGitDirectory(exec, '/repo')).toBe('/repo/.git')
  })
})
