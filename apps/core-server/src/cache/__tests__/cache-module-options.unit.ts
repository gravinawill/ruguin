import { type cacheENV } from '@ruguin/env'
import { describe, expect, it } from 'vitest'

import { createCacheModuleOptions } from '../cache-module-options'

const environmentWith = (overrides: Partial<typeof cacheENV> = {}): typeof cacheENV => ({
  CACHE_BREAKER_FAILURE_THRESHOLD: 5,
  CACHE_BREAKER_RESET_TIMEOUT_MS: 10_000,
  CACHE_DEFAULT_CONSISTENCY: 'eventual',
  CACHE_DEFAULT_TTL_MS: 300_000,
  CACHE_DRIVER: 'memory',
  CACHE_INVALIDATION_BROADCAST: true,
  CACHE_JITTER_RATIO: 0.1,
  CACHE_MASTER_URL: undefined,
  CACHE_NEGATIVE_TTL_MS: 30_000,
  CACHE_NS_VERSION_LOCAL_TTL_MS: 5000,
  CACHE_OPERATION_TIMEOUT_MS: 500,
  CACHE_PREFIX: 'ruguin:test',
  CACHE_REPLICA_URLS: [],
  CACHE_REPLICATION_LAG_THRESHOLD_BYTES: 1_048_576,
  ...overrides
})

describe('createCacheModuleOptions', () => {
  it('carries every validated setting through to the factory config', () => {
    const options = createCacheModuleOptions(environmentWith())

    expect(options).toMatchObject({
      breaker: { failureThreshold: 5, resetTimeoutInMs: 10_000 },
      defaultConsistency: 'eventual',
      defaultTtlInMs: 300_000,
      driver: 'memory',
      invalidationBroadcast: true,
      jitterRatio: 0.1,
      negativeTtlInMs: 30_000,
      prefix: 'ruguin:test'
    })
  })

  it('derives the lock TTL from the operation timeout', () => {
    expect(createCacheModuleOptions(environmentWith({ CACHE_OPERATION_TIMEOUT_MS: 250 })).lockTtlInMs).toBe(2500)
  })

  /*
   * Absent, not present-and-undefined. This app compiles with exactOptionalPropertyTypes, and the
   * factory's `masterUrl?: string` would reject an explicit undefined.
   */
  it('omits masterUrl and replicaUrls entirely when the environment has none', () => {
    const options = createCacheModuleOptions(environmentWith())

    expect(options).not.toHaveProperty('masterUrl')
    expect(options).not.toHaveProperty('replicaUrls')
  })

  it('passes the valkey endpoints through when they are configured', () => {
    const options = createCacheModuleOptions(
      environmentWith({
        CACHE_DRIVER: 'valkey',
        CACHE_MASTER_URL: 'redis://localhost:6379',
        CACHE_REPLICA_URLS: ['redis://localhost:6380']
      })
    )

    expect(options).toMatchObject({
      driver: 'valkey',
      masterUrl: 'redis://localhost:6379',
      replicaUrls: ['redis://localhost:6380']
    })
  })
})
