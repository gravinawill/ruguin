import { describe, expect, it } from 'vitest'

import { applyReviewDone } from '../mark-review-done'

describe('applyReviewDone', () => {
  const baseState = {
    diffHash: 'h1',
    deterministic: 'pass' as const,
    agenticReviewDone: false,
    overrideApproved: false
  }

  it('sets agenticReviewDone for the matching diff hash', () => {
    const next = applyReviewDone({ diffHash: 'h1', state: baseState })
    expect(next.agenticReviewDone).toBe(true)
    expect(next.overrideApproved).toBe(false)
  })

  it('sets overrideApproved and overrideReason when an override is given', () => {
    const next = applyReviewDone({ diffHash: 'h1', state: baseState, override: 'user confirmed, false positive' })
    expect(next.overrideApproved).toBe(true)
    expect(next.overrideReason).toBe('user confirmed, false positive')
  })

  it('throws when there is no state yet', () => {
    expect(() => applyReviewDone({ diffHash: 'h1', state: null })).toThrow(/no gate state/i)
  })

  it('throws when the diff hash does not match the stored state', () => {
    expect(() => applyReviewDone({ diffHash: 'h2', state: baseState })).toThrow(/diff has changed/i)
  })
})
