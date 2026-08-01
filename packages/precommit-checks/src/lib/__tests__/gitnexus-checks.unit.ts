import { describe, expect, it, vi } from 'vitest'

import { runCycleCheck, runDetectChanges, runImpactForSymbol } from '../gitnexus-checks'

describe('runCycleCheck', () => {
  it('does not block when clean', () => {
    const exec = vi
      .fn()
      .mockReturnValue({ status: 0, stdout: '{"status":"clean","cycleCount":0,"cycles":[]}', stderr: '' })
    const result = runCycleCheck(exec, '/repo')
    expect(result.blocking).toBe(false)
  })

  it('blocks when a cycle is found', () => {
    const exec = vi.fn().mockReturnValue({
      status: 0,
      stdout: '{"status":"cycles-found","cycleCount":1,"cycles":["a.ts -> b.ts -> a.ts"]}',
      stderr: ''
    })
    const result = runCycleCheck(exec, '/repo')
    expect(result.blocking).toBe(true)
    expect(result.message).toContain('a.ts -> b.ts -> a.ts')
  })

  it('warns (does not block) when the tool is unavailable', () => {
    const exec = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'command not found' })
    const result = runCycleCheck(exec, '/repo')
    expect(result.blocking).toBe(false)
    expect(result.warning).toBe(true)
  })

  /*
   * Multiple GitNexus-indexed repos sharing a package name (e.g. a main checkout plus its
   * worktrees) makes `.gitnexus/run.cjs` fail with an ambiguity error unless `-r/--repo` is
   * passed — confirmed empirically that the exact repo path (as GitNexus lists it) resolves it.
   */
  it('passes -r <repoRoot> to disambiguate multiple GitNexus-indexed repos sharing a package name', () => {
    const exec = vi
      .fn()
      .mockReturnValue({ status: 0, stdout: '{"status":"clean","cycleCount":0,"cycles":[]}', stderr: '' })
    runCycleCheck(exec, '/repo')
    expect(exec).toHaveBeenCalledWith('node', expect.arrayContaining(['-r', '/repo']))
  })
})

describe('runDetectChanges', () => {
  const sample = [
    'Changes: 2 files, 2 symbols',
    'Affected processes: 0',
    'Risk level: high',
    '',
    'Changed symbols:',
    '  Symbol RequestEmailSendUseCase → src/email/request-email-send.use-case.ts',
    '  Symbol EmailRepository → src/email/email.repository.ts'
  ].join('\n')

  it('blocks on HIGH/CRITICAL risk and extracts changed symbol names', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: sample, stderr: '' })
    const { result, changedSymbols } = runDetectChanges(exec, '/repo')
    expect(result.blocking).toBe(true)
    expect(changedSymbols).toEqual(['RequestEmailSendUseCase', 'EmailRepository'])
  })

  it('does not block on low risk', () => {
    const exec = vi
      .fn()
      .mockReturnValue({ status: 0, stdout: sample.replace('Risk level: high', 'Risk level: low'), stderr: '' })
    const { result } = runDetectChanges(exec, '/repo')
    expect(result.blocking).toBe(false)
  })

  it('passes -r <repoRoot> to disambiguate multiple GitNexus-indexed repos sharing a package name', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: sample, stderr: '' })
    runDetectChanges(exec, '/repo')
    expect(exec).toHaveBeenCalledWith('node', expect.arrayContaining(['-r', '/repo']))
  })
})

describe('runImpactForSymbol', () => {
  it('blocks on HIGH risk', () => {
    const exec = vi
      .fn()
      .mockReturnValue({ status: 0, stdout: '{"target":{"name":"X"},"risk":"HIGH","impactedCount":9}', stderr: '' })
    expect(runImpactForSymbol(exec, 'X', '/repo').blocking).toBe(true)
  })

  it('does not block on LOW risk', () => {
    const exec = vi
      .fn()
      .mockReturnValue({ status: 0, stdout: '{"target":{"name":"X"},"risk":"LOW","impactedCount":1}', stderr: '' })
    expect(runImpactForSymbol(exec, 'X', '/repo').blocking).toBe(false)
  })

  it('warns instead of blocking when the symbol cannot be resolved', () => {
    const exec = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'ambiguous symbol' })
    const result = runImpactForSymbol(exec, 'X', '/repo')
    expect(result.blocking).toBe(false)
    expect(result.warning).toBe(true)
  })

  it('passes -r <repoRoot> to disambiguate multiple GitNexus-indexed repos sharing a package name', () => {
    const exec = vi
      .fn()
      .mockReturnValue({ status: 0, stdout: '{"target":{"name":"X"},"risk":"LOW","impactedCount":1}', stderr: '' })
    runImpactForSymbol(exec, 'X', '/repo')
    expect(exec).toHaveBeenCalledWith('node', expect.arrayContaining(['-r', '/repo']))
  })
})
