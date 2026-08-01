import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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
  let directory: string
  let statePath: string

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'precommit-state-'))
    statePath = path.join(directory, 'state.json')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
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
