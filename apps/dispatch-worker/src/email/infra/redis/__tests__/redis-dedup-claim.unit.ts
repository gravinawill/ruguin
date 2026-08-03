import { type ICacheProvider } from '@ruguin/cache'
import { success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { RedisDedupClaim } from '../redis-dedup-claim.ts'

function fakeCache(setIfNotExists: ICacheProvider['setIfNotExists']): ICacheProvider {
  return { setIfNotExists } as unknown as ICacheProvider
}

describe('RedisDedupClaim', () => {
  it('claims a key that has never been claimed before', async () => {
    const setIfNotExists = vi.fn().mockResolvedValue(success({ stored: true }))
    const claim = new RedisDedupClaim(fakeCache(setIfNotExists))

    const result = await claim.claim({ key: 'email-1:0', ttlInMs: 60_000 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.claimed).toBe(true)
    }
    expect(setIfNotExists).toHaveBeenCalledWith({
      key: 'email-1:0',
      namespace: 'dispatch-worker-dedup',
      value: true,
      ttlInMs: 60_000
    })
  })

  it('does not claim a key that is already claimed', async () => {
    const setIfNotExists = vi.fn().mockResolvedValue(success({ stored: false }))
    const claim = new RedisDedupClaim(fakeCache(setIfNotExists))

    const result = await claim.claim({ key: 'email-1:0', ttlInMs: 60_000 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.claimed).toBe(false)
    }
  })
})
