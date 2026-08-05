import { type ICacheProvider } from '@ruguin/cache'
import { success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { RedisDedupClaim } from '../redis-dedup-claim.ts'

function fakeCache(overrides: Partial<Pick<ICacheProvider, 'setIfNotExists' | 'set' | 'delete'>>): ICacheProvider {
  return overrides as unknown as ICacheProvider
}

describe('RedisDedupClaim', () => {
  it('claims an EventBridge event id that has never been claimed before', async () => {
    const setIfNotExists = vi.fn().mockResolvedValue(success({ stored: true }))
    const claim = new RedisDedupClaim(fakeCache({ setIfNotExists }))

    const result = await claim.claim({ key: 'evt-1', ttlInMs: 300_000 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.claimed).toBe(true)
    expect(setIfNotExists).toHaveBeenCalledWith({
      key: 'evt-1',
      namespace: 'ses-webhook-ingestor-dedup',
      value: true,
      ttlInMs: 300_000
    })
  })

  it('does not claim an event id that is already claimed', async () => {
    const setIfNotExists = vi.fn().mockResolvedValue(success({ stored: false }))
    const claim = new RedisDedupClaim(fakeCache({ setIfNotExists }))

    const result = await claim.claim({ key: 'evt-1', ttlInMs: 300_000 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.claimed).toBe(false)
  })

  it('propagates a failure from the underlying cache when claiming', async () => {
    const cacheError = { name: 'CacheOperationError', message: 'connection reset' }
    const setIfNotExists = vi
      .fn()
      .mockResolvedValue({ isFailure: () => true, isSuccess: () => false, value: cacheError })
    const claim = new RedisDedupClaim(fakeCache({ setIfNotExists }))

    const result = await claim.claim({ key: 'evt-1', ttlInMs: 300_000 })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(cacheError)
  })

  it('confirms a claim by overwriting it with the full dedup TTL', async () => {
    const set = vi.fn().mockResolvedValue(success({ expiresAt: new Date() }))
    const claim = new RedisDedupClaim(fakeCache({ set }))

    const result = await claim.confirm({ key: 'evt-1', ttlInMs: 86_400_000 })

    expect(result.isSuccess()).toBe(true)
    expect(set).toHaveBeenCalledWith({
      key: 'evt-1',
      namespace: 'ses-webhook-ingestor-dedup',
      value: true,
      ttlInMs: 86_400_000
    })
  })

  it('propagates a failure from the underlying cache when confirming', async () => {
    const cacheError = { name: 'CacheOperationError', message: 'connection reset' }
    const set = vi.fn().mockResolvedValue({ isFailure: () => true, isSuccess: () => false, value: cacheError })
    const claim = new RedisDedupClaim(fakeCache({ set }))

    const result = await claim.confirm({ key: 'evt-1', ttlInMs: 86_400_000 })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(cacheError)
  })

  it('releases a claimed event id so a later redelivery can claim it again', async () => {
    const deleteFunction = vi.fn().mockResolvedValue(success({ existed: true }))
    const claim = new RedisDedupClaim(fakeCache({ delete: deleteFunction }))

    const result = await claim.release({ key: 'evt-1' })

    expect(result.isSuccess()).toBe(true)
    expect(deleteFunction).toHaveBeenCalledWith({ key: 'evt-1', namespace: 'ses-webhook-ingestor-dedup' })
  })

  it('propagates a failure from the underlying cache when releasing', async () => {
    const cacheError = { name: 'CacheOperationError', message: 'connection reset' }
    const deleteFunction = vi
      .fn()
      .mockResolvedValue({ isFailure: () => true, isSuccess: () => false, value: cacheError })
    const claim = new RedisDedupClaim(fakeCache({ delete: deleteFunction }))

    const result = await claim.release({ key: 'evt-1' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(cacheError)
  })
})
