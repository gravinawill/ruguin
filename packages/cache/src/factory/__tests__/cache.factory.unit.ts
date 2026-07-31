import { success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { CacheConsistency, CacheDriver, CacheLockOutcome, CacheSource } from '../../domain'
import { CacheFactory, type CacheFactoryDTO } from '../cache.factory'

const baseConfig = (overrides: Partial<CacheFactoryDTO.Config>): CacheFactoryDTO.Config => ({
  breaker: { failureThreshold: 5, resetTimeoutInMs: 10_000 },
  defaultConsistency: CacheConsistency.EVENTUAL,
  defaultTtlInMs: 300_000,
  driver: CacheDriver.MEMORY,
  invalidationBroadcast: false,
  jitterRatio: 0,
  lockTtlInMs: 5000,
  namespaceVersionLocalTtlInMs: 5000,
  negativeTtlInMs: 30_000,
  observability: false,
  onCacheError: vi.fn(),
  operationTimeoutInMs: 500,
  prefix: 'ruguin:test',
  replicationLagThresholdInBytes: 1_048_576,
  ...overrides
})

describe('CacheFactory', () => {
  it('builds a working memory provider', async () => {
    const created = CacheFactory.create(baseConfig({ driver: CacheDriver.MEMORY }))

    if (created.isFailure()) throw new Error('expected success')
    const provider = created.value
    await provider.connect()

    await provider.set({ key: 'a', namespace: 'user', value: { id: '1' } })
    const read = await provider.get<{ id: string }>({ key: 'a', namespace: 'user' })

    if (read.isFailure()) throw new Error('expected success')
    expect(read.value).toEqual({ found: true, value: { id: '1' } })
  })

  it('builds the noop provider, which misses on every read', async () => {
    const created = CacheFactory.create(baseConfig({ driver: CacheDriver.NOOP }))

    if (created.isFailure()) throw new Error('expected success')
    await created.value.connect()

    const read = await created.value.get({ key: 'a', namespace: 'user' })

    if (read.isFailure()) throw new Error('expected success')
    expect(read.value.found).toBe(false)
  })

  /*
   * @ruguin/env already refuses this combination at boot, but the factory takes a plain config
   * object and is reachable from a test or a service that never went through the env schema.
   */
  it('refuses the valkey driver without a master url', () => {
    const created = CacheFactory.create(baseConfig({ driver: CacheDriver.VALKEY }))

    if (created.isSuccess()) throw new Error('expected failure')
    expect(created.value.name).toBe('InvalidCacheConfigError')
    expect(created.value.message).toContain('masterUrl')
  })

  it('composes the two orchestrators on top of the driver', async () => {
    const created = CacheFactory.create(baseConfig({}))

    if (created.isFailure()) throw new Error('expected success')
    await created.value.connect()

    const loaded = await created.value.getOrSet<number, Error>({
      key: 'a',
      loader: () => Promise.resolve(success(42)),
      namespace: 'user'
    })

    if (loaded.isFailure()) throw new Error('expected success')
    expect(loaded.value.source).toBe(CacheSource.LOADER)
    expect(loaded.value.lockOutcome).toBe(CacheLockOutcome.NOT_ATTEMPTED)
  })
})
