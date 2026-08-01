import { describe, expect, it, vi } from 'vitest'

import { resolveGitDirectory } from '../git'

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
