import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { complexityRegressed, dependenciesRegressed, readBaseline, writeBaseline } from '../baseline'

describe('readBaseline', () => {
  it('returns an empty baseline when the file is missing', () => {
    expect(readBaseline('/does/not/exist.json')).toEqual({ updatedAt: '', complexity: {}, dependencies: {} })
  })

  it('returns a fresh object (and fresh nested complexity/dependencies objects) on every call, so a mutating caller cannot corrupt a shared constant', () => {
    const first = readBaseline('/does/not/exist.json')
    const second = readBaseline('/does/not/exist.json')

    expect(first).not.toBe(second)
    expect(first.complexity).not.toBe(second.complexity)
    expect(first.dependencies).not.toBe(second.dependencies)

    first.complexity['src/a.ts'] = { cyclomatic: 99, cognitive: 99 }
    expect(second.complexity).toEqual({})
  })
})

describe('readBaseline / writeBaseline round-trip', () => {
  let directory: string
  let baselinePath: string

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'baseline-'))
    baselinePath = path.join(directory, 'baseline.json')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('round-trips', () => {
    const baseline = {
      updatedAt: '2026-07-31T00:00:00.000Z',
      complexity: { 'src/a.ts': { cyclomatic: 3, cognitive: 2 } },
      dependencies: { 'src/a.ts': { connections: 4 } }
    }
    writeBaseline(baselinePath, baseline)
    expect(readBaseline(baselinePath)).toEqual(baseline)
  })
})

describe('complexityRegressed', () => {
  const baseline = { updatedAt: '', complexity: { 'src/a.ts': { cyclomatic: 5, cognitive: 5 } }, dependencies: {} }

  it('is false when there is no baseline entry for the file (new file)', () => {
    expect(complexityRegressed(baseline, 'src/new.ts', { cyclomatic: 100, cognitive: 100 })).toBe(false)
  })

  it('is false when both metrics stayed the same or improved', () => {
    expect(complexityRegressed(baseline, 'src/a.ts', { cyclomatic: 5, cognitive: 4 })).toBe(false)
  })

  it('is true when cyclomatic increased', () => {
    expect(complexityRegressed(baseline, 'src/a.ts', { cyclomatic: 6, cognitive: 5 })).toBe(true)
  })

  it('is true when cognitive increased', () => {
    expect(complexityRegressed(baseline, 'src/a.ts', { cyclomatic: 5, cognitive: 6 })).toBe(true)
  })
})

describe('dependenciesRegressed', () => {
  const baseline = { updatedAt: '', complexity: {}, dependencies: { 'src/a.ts': { connections: 3 } } }

  it('is false for a new file', () => {
    expect(dependenciesRegressed(baseline, 'src/new.ts', { connections: 50 })).toBe(false)
  })

  it('is true when connections increased', () => {
    expect(dependenciesRegressed(baseline, 'src/a.ts', { connections: 4 })).toBe(true)
  })

  it('is false when connections stayed the same', () => {
    expect(dependenciesRegressed(baseline, 'src/a.ts', { connections: 3 })).toBe(false)
  })
})
