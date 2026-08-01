import { execFileSync } from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { decideGate, runDeterministicChecksSubprocess } from '../claude-precommit-gate'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

describe('decideGate', () => {
  it('reruns and denies when there is no prior state', () => {
    const runDeterministicChecks = vi
      .fn()
      .mockReturnValue({ pass: false, findings: ['cycle found'], diffHashAfterChecks: 'h1' })
    const result = decideGate({ diffHash: 'h1', state: null, runDeterministicChecks })
    expect(result.allow).toBe(false)
    expect(result.reason).toContain('cycle found')
    expect(runDeterministicChecks).toHaveBeenCalledOnce()
  })

  it('reruns when the diff hash changed since the stored state', () => {
    const runDeterministicChecks = vi.fn().mockReturnValue({ pass: true, findings: [], diffHashAfterChecks: 'new' })
    const staleState = {
      diffHash: 'old',
      deterministic: 'fail' as const,
      agenticReviewDone: true,
      overrideApproved: false
    }
    const result = decideGate({ diffHash: 'new', state: staleState, runDeterministicChecks })
    expect(runDeterministicChecks).toHaveBeenCalledOnce()
    expect(result.nextState.agenticReviewDone).toBe(false)
  })

  it('stores the post-check diff hash, not the pre-check hash — a passing deterministic run can mutate the staged diff (e.g. staging an updated baseline file), so the persisted state must reflect what is staged NOW, matching what mark-review-done.ts will independently recompute later', () => {
    const runDeterministicChecks = vi
      .fn()
      .mockReturnValue({ pass: true, findings: [], diffHashAfterChecks: 'h1-plus-baseline' })
    const result = decideGate({ diffHash: 'h1', state: null, runDeterministicChecks })
    expect(result.nextState.diffHash).toBe('h1-plus-baseline')
    expect(result.nextState.diffHash).not.toBe('h1')
  })

  it('denies asking for review when deterministic passed but review is not done', () => {
    const runDeterministicChecks = vi.fn()
    const state = { diffHash: 'h1', deterministic: 'pass' as const, agenticReviewDone: false, overrideApproved: false }
    const result = decideGate({ diffHash: 'h1', state, runDeterministicChecks })
    expect(result.allow).toBe(false)
    expect(result.reason).toContain('code review')
    expect(runDeterministicChecks).not.toHaveBeenCalled()
  })

  it('allows when deterministic passed and review is done, for the same hash', () => {
    const state = { diffHash: 'h1', deterministic: 'pass' as const, agenticReviewDone: true, overrideApproved: false }
    const result = decideGate({ diffHash: 'h1', state, runDeterministicChecks: vi.fn() })
    expect(result.allow).toBe(true)
  })

  it('allows when overrideApproved is true, even without agenticReviewDone', () => {
    const state = { diffHash: 'h1', deterministic: 'pass' as const, agenticReviewDone: false, overrideApproved: true }
    const result = decideGate({ diffHash: 'h1', state, runDeterministicChecks: vi.fn() })
    expect(result.allow).toBe(true)
  })

  it('denies when deterministic failed and no override is approved', () => {
    const state = { diffHash: 'h1', deterministic: 'fail' as const, agenticReviewDone: false, overrideApproved: false }
    const result = decideGate({ diffHash: 'h1', state, runDeterministicChecks: vi.fn() })
    expect(result.allow).toBe(false)
    expect(result.reason).toContain('Deterministic checks previously failed')
    expect(result.nextState).toBe(state)
  })

  it('allows when deterministic failed but overrideApproved is true — an approved override must be able to unblock a deterministic failure, not only a pending agentic review', () => {
    const state = { diffHash: 'h1', deterministic: 'fail' as const, agenticReviewDone: false, overrideApproved: true }
    const result = decideGate({ diffHash: 'h1', state, runDeterministicChecks: vi.fn() })
    expect(result.allow).toBe(true)
    expect(result.reason).toContain('override')
  })
})

describe('runDeterministicChecksSubprocess', () => {
  const mockedExecFileSync = vi.mocked(execFileSync)

  afterEach(() => {
    mockedExecFileSync.mockReset()
  })

  it("passes an explicit timeout (comfortably under the PreToolUse hook's own 150000ms) and a maxBuffer to execFileSync", () => {
    mockedExecFileSync
      .mockReturnValueOnce('PRECOMMIT_RESULT=PASS\n') // npx tsx pre-commit-checks.ts
      .mockReturnValueOnce('') // git diff --cached

    runDeterministicChecksSubprocess()

    const [command, arguments_, options] = mockedExecFileSync.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>
    ]
    expect(command).toBe('npx')
    expect(arguments_).toContain('tsx')
    expect(options.timeout).toBeGreaterThan(0)
    expect(options.timeout as number).toBeLessThan(150_000)
    expect(options.maxBuffer).toBe(64 * 1024 * 1024)
  })

  it('treats a timeout-triggered kill (SIGTERM/ETIMEDOUT) as a clean deterministic-check failure with a clear message, instead of letting the exception propagate uncaught', () => {
    const timeoutError = Object.assign(new Error('spawnSync npx ETIMEDOUT'), {
      status: null,
      signal: 'SIGTERM',
      code: 'ETIMEDOUT',
      stdout: '',
      stderr: ''
    })
    mockedExecFileSync
      .mockImplementationOnce(() => {
        throw timeoutError
      })
      .mockReturnValueOnce('') // git diff --cached, still called to compute diffHashAfterChecks

    const result = runDeterministicChecksSubprocess()

    expect(result.pass).toBe(false)
    expect(result.findings[0]).toContain('timed out')
    expect(result.diffHashAfterChecks).toBeTruthy()
  })
})
