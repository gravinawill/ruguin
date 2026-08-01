import { describe, expect, it } from 'vitest'

import { CacheConsistency, CacheDriver, CacheHealthStatus, CacheLockOutcome, CacheSource } from '../index.ts'

describe('cache enums', () => {
  it('lists every supported driver', () => {
    expect(Object.values(CacheDriver)).toEqual(['valkey', 'memory', 'noop'])
  })

  it('lists both consistency modes', () => {
    expect(Object.values(CacheConsistency)).toEqual(['eventual', 'strong'])
  })

  it('lists the three health statuses', () => {
    expect(Object.values(CacheHealthStatus)).toEqual(['healthy', 'degraded', 'unhealthy'])
  })

  it('keeps the lock outcome three-valued, so a refused lock is not just a missing one', () => {
    expect(Object.values(CacheLockOutcome)).toEqual(['not-attempted', 'acquired', 'not-acquired'])
  })

  it('distinguishes a cache hit from a loader result', () => {
    expect(CacheSource.CACHE).toBe('cache')
    expect(CacheSource.LOADER).toBe('loader')
  })
})
