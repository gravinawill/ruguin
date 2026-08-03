import { type ICacheProvider } from '@ruguin/cache'
import { success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { RedisRateLimiter } from '../redis-rate-limiter.ts'

function fakeCache(increment: ICacheProvider['increment']): ICacheProvider {
  return { increment } as unknown as ICacheProvider
}

describe('RedisRateLimiter', () => {
  it('allows the request when the counter is within the limit', async () => {
    const increment = vi.fn().mockResolvedValue(success({ value: 3 }))
    const limiter = new RedisRateLimiter(fakeCache(increment))

    const result = await limiter.check({ key: 'ses-account', limit: 14, windowInMs: 1000 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.allowed).toBe(true)
    }
    expect(increment).toHaveBeenCalledWith({
      key: 'ses-account',
      namespace: 'dispatch-worker-rate-limit',
      windowInMs: 1000
    })
  })

  it('denies the request when the counter exceeds the limit', async () => {
    const increment = vi.fn().mockResolvedValue(success({ value: 15 }))
    const limiter = new RedisRateLimiter(fakeCache(increment))

    const result = await limiter.check({ key: 'ses-account', limit: 14, windowInMs: 1000 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.allowed).toBe(false)
    }
  })

  it('allows the request when the counter exactly equals the limit (the check is inclusive)', async () => {
    const increment = vi.fn().mockResolvedValue(success({ value: 14 }))
    const limiter = new RedisRateLimiter(fakeCache(increment))

    const result = await limiter.check({ key: 'ses-account', limit: 14, windowInMs: 1000 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.allowed).toBe(true)
    }
  })

  it('propagates a failure from the underlying cache instead of treating it as allowed or denied', async () => {
    const cacheError = { name: 'CacheOperationError', message: 'connection reset' }
    const increment = vi.fn().mockResolvedValue({ isFailure: () => true, isSuccess: () => false, value: cacheError })
    const limiter = new RedisRateLimiter(fakeCache(increment))

    const result = await limiter.check({ key: 'ses-account', limit: 14, windowInMs: 1000 })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value).toBe(cacheError)
    }
  })
})
