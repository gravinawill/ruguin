import { describe, expect, it } from 'vitest'

import { CacheDriver, CacheHealthStatus, type ICacheDriver } from '../../../../domain'
import { NoopCacheDriver } from '../noop-cache.driver'

describe('NoopCacheDriver', () => {
  // Typed as the contract it exists to satisfy, the same way a consumer would inject it.
  const provider: ICacheDriver = new NoopCacheDriver()

  it('always misses on read', async () => {
    const result = await provider.get<string>({ key: 'a', namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toBeNull()
  })

  it('accepts a write and discards it', async () => {
    const written = await provider.set({ key: 'a', namespace: 'user', value: 'v', ttlInMs: 1000 })
    const read = await provider.get<string>({ key: 'a', namespace: 'user' })

    expect(written.isSuccess()).toBe(true)
    if (read.isFailure()) throw new Error('expected success')
    expect(read.value.value).toBeNull()
  })

  it('grants every lock, since there is nothing to coordinate', async () => {
    const first = await provider.acquire({ key: 'a', namespace: 'user', ttlInMs: 1000 })
    const second = await provider.acquire({ key: 'a', namespace: 'user', ttlInMs: 1000 })

    expect(first.isSuccess()).toBe(true)
    expect(second.isSuccess()).toBe(true)
  })

  it('reports itself as healthy', async () => {
    const result = await provider.healthCheck()

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.status).toBe(CacheHealthStatus.HEALTHY)
    expect(result.value.driver).toBe(CacheDriver.NOOP)
    expect(result.value.replicas).toEqual([])
  })

  it('counts from zero on every increment because nothing persists', async () => {
    await provider.increment({ key: 'hits', namespace: 'rate' })
    const second = await provider.increment({ key: 'hits', namespace: 'rate' })

    if (second.isFailure()) throw new Error('expected success')
    expect(second.value.value).toBe(0)
  })
})
