import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeDiffHash, readState, writeState } from '../precommit-state'

describe('computeDiffHash', () => {
  it('is deterministic for the same input', () => {
    expect(computeDiffHash('diff --git a b')).toBe(computeDiffHash('diff --git a b'))
  })

  it('differs for different input', () => {
    expect(computeDiffHash('a')).not.toBe(computeDiffHash('b'))
  })
})

describe('readState / writeState', () => {
  let dir: string
  let statePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'precommit-state-'))
    statePath = join(dir, 'state.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when the file does not exist', () => {
    expect(readState(statePath)).toBeNull()
  })

  it('round-trips a written state', () => {
    const state = { diffHash: 'abc', deterministic: 'pass' as const, agenticReviewDone: false, overrideApproved: false }
    writeState(statePath, state)
    expect(readState(statePath)).toEqual(state)
  })

  it('returns null for a corrupted file instead of throwing', () => {
    writeState(statePath, { diffHash: 'x', deterministic: 'pass', agenticReviewDone: false, overrideApproved: false })
    // corrupt it
    writeFileSync(statePath, '{not valid json')
    expect(readState(statePath)).toBeNull()
  })
})
