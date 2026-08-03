import { afterEach, describe, expect, it, vi } from 'vitest'

const setEnvironment = (environment: Record<string, string>): void => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
}

const BASE_ENVIRONMENT = {
  CACHE_BREAKER_FAILURE_THRESHOLD: '5',
  CACHE_BREAKER_RESET_TIMEOUT_MS: '10000',
  CACHE_DEFAULT_CONSISTENCY: 'eventual',
  CACHE_DEFAULT_TTL_MS: '300000',
  CACHE_DRIVER: 'memory',
  CACHE_INVALIDATION_BROADCAST: 'true',
  CACHE_JITTER_RATIO: '0.1',
  CACHE_NEGATIVE_TTL_MS: '30000',
  CACHE_NS_VERSION_LOCAL_TTL_MS: '5000',
  CACHE_OPERATION_TIMEOUT_MS: '500',
  CACHE_PREFIX: 'ruguin:test',
  CACHE_REPLICATION_LAG_THRESHOLD_BYTES: '1048576'
}

describe('createCacheModuleOptions', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('carries every validated setting through to the factory config', async () => {
    setEnvironment(BASE_ENVIRONMENT)
    const { createCacheModuleOptions } = await import('../cache-module-options')

    const options = createCacheModuleOptions()

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

  it('derives the lock TTL from the operation timeout', async () => {
    setEnvironment({ ...BASE_ENVIRONMENT, CACHE_OPERATION_TIMEOUT_MS: '250' })
    const { createCacheModuleOptions } = await import('../cache-module-options')

    expect(createCacheModuleOptions().lockTtlInMs).toBe(2500)
  })

  /*
   * Absent, not present-and-undefined. This app compiles with exactOptionalPropertyTypes, and the
   * factory's `masterUrl?: string` would reject an explicit undefined.
   */
  it('omits masterUrl and replicaUrls entirely when the environment has none', async () => {
    setEnvironment(BASE_ENVIRONMENT)
    const { createCacheModuleOptions } = await import('../cache-module-options')

    const options = createCacheModuleOptions()

    expect(options).not.toHaveProperty('masterUrl')
    expect(options).not.toHaveProperty('replicaUrls')
  })

  it('passes the valkey endpoints through when they are configured', async () => {
    setEnvironment({
      ...BASE_ENVIRONMENT,
      CACHE_DRIVER: 'valkey',
      CACHE_MASTER_URL: 'redis://localhost:6379',
      CACHE_REPLICA_URLS: 'redis://localhost:6380'
    })
    const { createCacheModuleOptions } = await import('../cache-module-options')

    const options = createCacheModuleOptions()

    expect(options).toMatchObject({
      driver: 'valkey',
      masterUrl: 'redis://localhost:6379',
      replicaUrls: ['redis://localhost:6380']
    })
  })
})
