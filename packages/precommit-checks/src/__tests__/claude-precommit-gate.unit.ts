import { describe, expect, it, vi } from 'vitest'

import { decideGate } from '../claude-precommit-gate'

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
})
