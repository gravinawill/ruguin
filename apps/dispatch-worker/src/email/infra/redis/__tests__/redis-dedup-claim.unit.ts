import { type ICacheProvider } from '@ruguin/cache'
import { success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { RedisDedupClaim } from '../redis-dedup-claim.ts'

function fakeCache(overrides: Partial<Pick<ICacheProvider, 'setIfNotExists' | 'delete'>>): ICacheProvider {
  return overrides as unknown as ICacheProvider
}

describe('RedisDedupClaim', () => {
  it('claims a key that has never been claimed before', async () => {
    const setIfNotExists = vi.fn().mockResolvedValue(success({ stored: true }))
    const claim = new RedisDedupClaim(fakeCache({ setIfNotExists }))

    const result = await claim.claim({ key: 'email-1-0', ttlInMs: 60_000 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.claimed).toBe(true)
    }
    expect(setIfNotExists).toHaveBeenCalledWith({
      key: 'email-1-0',
      namespace: 'dispatch-worker-dedup',
      value: true,
      ttlInMs: 60_000
    })
  })

  it('does not claim a key that is already claimed', async () => {
    const setIfNotExists = vi.fn().mockResolvedValue(success({ stored: false }))
    const claim = new RedisDedupClaim(fakeCache({ setIfNotExists }))

    const result = await claim.claim({ key: 'email-1-0', ttlInMs: 60_000 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.claimed).toBe(false)
    }
  })

  it('propagates a failure from the underlying cache when claiming', async () => {
    const cacheError = { name: 'CacheOperationError', message: 'connection reset' }
    const setIfNotExists = vi
      .fn()
      .mockResolvedValue({ isFailure: () => true, isSuccess: () => false, value: cacheError })
    const claim = new RedisDedupClaim(fakeCache({ setIfNotExists }))

    const result = await claim.claim({ key: 'email-1-0', ttlInMs: 60_000 })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value).toBe(cacheError)
    }
  })

  it('releases a claimed key so a later redelivery can claim it again', async () => {
    const deleteFunction = vi.fn().mockResolvedValue(success({ existed: true }))
    const claim = new RedisDedupClaim(fakeCache({ delete: deleteFunction }))

    const result = await claim.release({ key: 'email-1-0' })

    expect(result.isSuccess()).toBe(true)
    expect(deleteFunction).toHaveBeenCalledWith({ key: 'email-1-0', namespace: 'dispatch-worker-dedup' })
  })

  it('propagates a failure from the underlying cache when releasing', async () => {
    const cacheError = { name: 'CacheOperationError', message: 'connection reset' }
    const deleteFunction = vi
      .fn()
      .mockResolvedValue({ isFailure: () => true, isSuccess: () => false, value: cacheError })
    const claim = new RedisDedupClaim(fakeCache({ delete: deleteFunction }))

    const result = await claim.release({ key: 'email-1-0' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value).toBe(cacheError)
    }
  })
})
