import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MemoryStore } from '../memory.store.ts'

describe('MemoryStore', () => {
  let store: MemoryStore

  beforeEach(() => {
    vi.useFakeTimers()
    store = new MemoryStore()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a stored value before it expires', () => {
    store.setValue({ key: 'a', serialized: '"v"', ttlInMs: 1000 })

    expect(store.getValue({ key: 'a' })).toBe('"v"')
  })

  it('drops the value once the ttl has passed', () => {
    store.setValue({ key: 'a', serialized: '"v"', ttlInMs: 1000 })
    vi.advanceTimersByTime(1001)

    expect(store.getValue({ key: 'a' })).toBeNull()
  })

  it('reports whether a delete removed anything', () => {
    store.setValue({ key: 'a', serialized: '"v"', ttlInMs: 1000 })

    expect(store.deleteValue({ key: 'a' })).toBe(true)
    expect(store.deleteValue({ key: 'a' })).toBe(false)
  })

  it('stores only when absent, and treats an expired key as absent', () => {
    expect(store.setValueIfAbsent({ key: 'a', serialized: '"1"', ttlInMs: 1000 })).toBe(true)
    expect(store.setValueIfAbsent({ key: 'a', serialized: '"2"', ttlInMs: 1000 })).toBe(false)

    vi.advanceTimersByTime(1001)

    expect(store.setValueIfAbsent({ key: 'a', serialized: '"3"', ttlInMs: 1000 })).toBe(true)
    expect(store.getValue({ key: 'a' })).toBe('"3"')
  })

  it('accumulates counters and reads zero for an unknown key', () => {
    expect(store.getCounter({ key: 'hits' })).toBe(0)
    expect(store.incrementCounter({ key: 'hits', by: 1 })).toBe(1)
    expect(store.incrementCounter({ key: 'hits', by: 4 })).toBe(5)
    expect(store.incrementCounter({ key: 'hits', by: -2 })).toBe(3)
  })

  it('keeps the ttl set on the first increment and does not extend it later', () => {
    store.incrementCounter({ key: 'hits', by: 1, ttlInMs: 1000 })
    vi.advanceTimersByTime(600)
    store.incrementCounter({ key: 'hits', by: 1, ttlInMs: 1000 })
    vi.advanceTimersByTime(500)

    expect(store.getCounter({ key: 'hits' })).toBe(0)
  })

  it('grants a lock once and refuses it while held', () => {
    expect(store.acquireLock({ key: 'l', token: 't1', ttlInMs: 1000 })).toBe(true)
    expect(store.acquireLock({ key: 'l', token: 't2', ttlInMs: 1000 })).toBe(false)
  })

  it('grants the lock again after it expires', () => {
    store.acquireLock({ key: 'l', token: 't1', ttlInMs: 1000 })
    vi.advanceTimersByTime(1001)

    expect(store.acquireLock({ key: 'l', token: 't2', ttlInMs: 1000 })).toBe(true)
  })

  it('refuses to release a lock held by someone else', () => {
    store.acquireLock({ key: 'l', token: 't1', ttlInMs: 1000 })

    expect(store.releaseLock({ key: 'l', token: 't2' })).toBe('not-owned')
    expect(store.releaseLock({ key: 'l', token: 't1' })).toBe('released')
  })

  it('extends only for the current owner', () => {
    store.acquireLock({ key: 'l', token: 't1', ttlInMs: 1000 })

    expect(store.extendLock({ key: 'l', token: 't2', ttlInMs: 5000 })).toBe(false)
    expect(store.extendLock({ key: 'l', token: 't1', ttlInMs: 5000 })).toBe(true)

    vi.advanceTimersByTime(4000)

    expect(store.acquireLock({ key: 'l', token: 't3', ttlInMs: 1000 })).toBe(false)
  })

  it('ranks members by score descending, one-based', () => {
    store.setScore({ key: 'board', member: 'a', score: 10 })
    store.setScore({ key: 'board', member: 'b', score: 30 })
    store.setScore({ key: 'board', member: 'c', score: 20 })

    expect(store.getRankAndTotal({ key: 'board', member: 'b' })).toEqual({ rank: 1, total: 3 })
    expect(store.getRankAndTotal({ key: 'board', member: 'a' })).toEqual({ rank: 3, total: 3 })
    expect(store.getRankAndTotal({ key: 'board', member: 'zz' })).toEqual({ rank: null, total: 3 })
  })

  it('returns the top scores honouring limit and offset', () => {
    store.setScore({ key: 'board', member: 'a', score: 10 })
    store.setScore({ key: 'board', member: 'b', score: 30 })
    store.setScore({ key: 'board', member: 'c', score: 20 })

    expect(store.getTopScores({ key: 'board', limit: 2 })).toEqual([
      { member: 'b', score: 30 },
      { member: 'c', score: 20 }
    ])
    expect(store.getTopScores({ key: 'board', limit: 2, offset: 1 })).toEqual([
      { member: 'c', score: 20 },
      { member: 'a', score: 10 }
    ])
  })

  it('breaks score ties by member bytes, not by locale', () => {
    store.setScore({ key: 'board', member: 'b', score: 10 })
    store.setScore({ key: 'board', member: 'a', score: 10 })

    expect(store.getTopScores({ key: 'board', limit: 2 })).toEqual([
      { member: 'a', score: 10 },
      { member: 'b', score: 10 }
    ])
  })

  it('puts uppercase before lowercase on a tie, the way Valkey orders ZSET members', () => {
    store.setScore({ key: 'board', member: 'a', score: 10 })
    store.setScore({ key: 'board', member: 'B', score: 10 })

    // `'B'.localeCompare('a')` is 1, so a locale tiebreak would put 'a' first here.
    expect(store.getTopScores({ key: 'board', limit: 2 })).toEqual([
      { member: 'B', score: 10 },
      { member: 'a', score: 10 }
    ])
  })

  it('reports whether setScore created or updated the member', () => {
    expect(store.setScore({ key: 'board', member: 'a', score: 1 })).toBe(true)
    expect(store.setScore({ key: 'board', member: 'a', score: 2 })).toBe(false)
    expect(store.getScore({ key: 'board', member: 'a' })).toBe(2)
  })

  it('accumulates and removes members', () => {
    store.incrementScore({ key: 'board', member: 'a', by: 5 })
    store.incrementScore({ key: 'board', member: 'a', by: 3 })

    expect(store.getScore({ key: 'board', member: 'a' })).toBe(8)
    expect(store.countScores({ key: 'board' })).toBe(1)
    expect(store.removeScore({ key: 'board', member: 'a' })).toBe(true)
    expect(store.removeScore({ key: 'board', member: 'a' })).toBe(false)
    expect(store.countScores({ key: 'board' })).toBe(0)
  })

  it('expires a whole sorted set by its key ttl', () => {
    store.setScore({ key: 'board', member: 'a', score: 1, ttlInMs: 1000 })
    vi.advanceTimersByTime(1001)

    expect(store.countScores({ key: 'board' })).toBe(0)
    expect(store.getScore({ key: 'board', member: 'a' })).toBeNull()
  })

  it('starts namespace versions at one and bumps them monotonically', () => {
    expect(store.getVersion({ namespace: 'user' })).toBe(1)
    expect(store.bumpVersion({ namespace: 'user' })).toBe(2)
    expect(store.bumpVersion({ namespace: 'user' })).toBe(3)
    expect(store.getVersion({ namespace: 'order' })).toBe(1)
  })

  it('wipes everything on clear', () => {
    store.setValue({ key: 'a', serialized: '"v"', ttlInMs: 1000 })
    store.bumpVersion({ namespace: 'user' })
    store.clear()

    expect(store.getValue({ key: 'a' })).toBeNull()
    expect(store.getVersion({ namespace: 'user' })).toBe(1)
  })
})
