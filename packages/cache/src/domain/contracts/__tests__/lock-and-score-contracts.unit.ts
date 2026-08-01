import { success } from '@ruguin/utils'
import { describe, expect, it } from 'vitest'

import {
  type AcquireLockProviderDTO,
  type GetRankProviderDTO,
  type GetTopScoresProviderDTO,
  type IAcquireLockProvider,
  type IGetRankProvider,
  type IGetTopScoresProvider,
  type IReleaseLockProvider,
  type ReleaseLockProviderDTO
} from '../index.ts'

class StubLock implements IAcquireLockProvider, IReleaseLockProvider {
  public acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    return Promise.resolve(success({ token: 'token-1', expiresAt: new Date(input.ttlInMs) }))
  }

  public release(): ReleaseLockProviderDTO.Output {
    return Promise.resolve(success({ released: true }))
  }
}

class StubScore implements IGetRankProvider, IGetTopScoresProvider {
  public getRank(): GetRankProviderDTO.Output {
    return Promise.resolve(success({ rank: 11, total: 340 }))
  }

  public getTopScores(): GetTopScoresProviderDTO.Output {
    return Promise.resolve(success({ entries: [{ member: 'a', score: 10 }] }))
  }
}

describe('lock and score contracts', () => {
  it('requires an explicit ttl to acquire a lock', async () => {
    const lock = new StubLock()
    const result = await lock.acquire({ key: 'user:1', namespace: 'user', ttlInMs: 5000 })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.token).toBe('token-1')
  })

  it('requires the owner token to release a lock', async () => {
    const lock: IReleaseLockProvider = new StubLock()
    const result = await lock.release({ key: 'user:1', namespace: 'user', token: 'token-1' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.released).toBe(true)
  })

  it('returns rank alongside the total so callers can render "11th of 340"', async () => {
    const score: IGetRankProvider = new StubScore()
    const result = await score.getRank({ key: 'weekly', namespace: 'leaderboard', member: 'a' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value).toEqual({ rank: 11, total: 340 })
  })
})
