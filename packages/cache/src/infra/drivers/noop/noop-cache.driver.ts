import { failure, success } from '@ruguin/utils'

import {
  type AcquireLockProviderDTO,
  CacheDriver,
  CacheHealthStatus,
  type ConnectProviderDTO,
  type CountScoresProviderDTO,
  type DecrementCounterProviderDTO,
  type DeleteCacheProviderDTO,
  type DisconnectProviderDTO,
  type ExtendLockProviderDTO,
  type GetCacheProviderDTO,
  type GetCounterProviderDTO,
  type GetRankProviderDTO,
  type GetScoreProviderDTO,
  type GetTopScoresProviderDTO,
  type HealthCheckProviderDTO,
  type ICacheDriver,
  type IncrementCounterProviderDTO,
  type IncrementScoreProviderDTO,
  type InvalidateNamespaceProviderDTO,
  LockNotAcquiredError,
  LockNotOwnedError,
  type ReleaseLockProviderDTO,
  type RemoveScoreProviderDTO,
  type ResolveNamespaceVersionProviderDTO,
  type SetCacheProviderDTO,
  type SetIfNotExistsCacheProviderDTO,
  type SetScoreProviderDTO
} from '../../../domain/index.ts'

/*
 * This driver keeps no state, so it can never own a lock. The key only exists to make the
 * error readable in a log; it mirrors KeyBuilder.buildLockKey's shape under a `noop` prefix.
 */
const lockKeyOf = (input: { namespace: string; key: string }): string => `noop:${input.namespace}:__lock__:${input.key}`

export class NoopCacheDriver implements ICacheDriver {
  public get<T>(): GetCacheProviderDTO.Output<T> {
    return Promise.resolve(success({ found: false, value: null }))
  }

  public set(): SetCacheProviderDTO.Output {
    return Promise.resolve(success({ expiresAt: new Date() }))
  }

  public delete(): DeleteCacheProviderDTO.Output {
    return Promise.resolve(success({ existed: false }))
  }

  /*
   * `stored: true` for every caller, unlike `acquire` below. The two look alike but differ in
   * kind: `acquire` hands back a token that *asserts* exclusivity, while `stored` only reports
   * that the key was absent — which is permanently true here, since every read misses. It lies
   * about durability exactly as much as `set` already does, and it lies in the safe direction:
   * a caller guarding a side effect with it runs the work rather than skipping it forever.
   */
  public setIfNotExists(): SetIfNotExistsCacheProviderDTO.Output {
    return Promise.resolve(success({ stored: true }))
  }

  public increment(): IncrementCounterProviderDTO.Output {
    return Promise.resolve(success({ value: 0 }))
  }

  public decrement(): DecrementCounterProviderDTO.Output {
    return Promise.resolve(success({ value: 0 }))
  }

  public getCounter(): GetCounterProviderDTO.Output {
    return Promise.resolve(success({ value: 0 }))
  }

  /*
   * Refused, never granted. A granted lock is a promise of mutual exclusion, and this driver
   * coordinates nothing: handing out a token would let every concurrent caller of
   * `executeWithLock` run its task in parallel and each be told it held the lock exclusively.
   * That is the one operation in the package that deliberately refuses to fail open, so the
   * honest answer is the same one a permanently contended lock gives. `attempts: 0` says why:
   * we did not try and fail, there is nothing here to try against.
   */
  public acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    const lockKey: string = lockKeyOf(input)

    return Promise.resolve(failure(new LockNotAcquiredError({ lockKey, attempts: 0 })))
  }

  /*
   * `released: false` rather than an error: since `acquire` never grants, nothing can ever be
   * held, and the contract already has a boolean for "nothing was released". Failing here would
   * only push noise into `onCacheError` for callers that release defensively in a `finally`.
   */
  public release(): ReleaseLockProviderDTO.Output {
    return Promise.resolve(success({ released: false }))
  }

  /*
   * Failure, unlike `release`, because the success shape is a bare `expiresAt` — there is no
   * honest value to put in it for a lock that was never granted. Returning a Date would claim
   * an extension happened.
   */
  public extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output {
    const lockKey: string = lockKeyOf(input)

    return Promise.resolve(failure(new LockNotOwnedError({ lockKey })))
  }

  public setScore(): SetScoreProviderDTO.Output {
    return Promise.resolve(success({ created: true }))
  }

  public incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output {
    return Promise.resolve(success({ score: input.by }))
  }

  public getScore(): GetScoreProviderDTO.Output {
    return Promise.resolve(success({ score: null }))
  }

  public getRank(): GetRankProviderDTO.Output {
    return Promise.resolve(success({ rank: null, total: 0 }))
  }

  public getTopScores(): GetTopScoresProviderDTO.Output {
    return Promise.resolve(success({ entries: [] }))
  }

  public removeScore(): RemoveScoreProviderDTO.Output {
    return Promise.resolve(success({ removed: false }))
  }

  public countScores(): CountScoresProviderDTO.Output {
    return Promise.resolve(success({ total: 0 }))
  }

  public invalidateNamespace(): InvalidateNamespaceProviderDTO.Output {
    return Promise.resolve(success({ version: 1 }))
  }

  public resolveNamespaceVersion(): ResolveNamespaceVersionProviderDTO.Output {
    return Promise.resolve(success({ version: 1 }))
  }

  public connect(): ConnectProviderDTO.Output {
    return Promise.resolve(success({ connected: true }))
  }

  public disconnect(): DisconnectProviderDTO.Output {
    return Promise.resolve(success({ disconnected: true }))
  }

  public healthCheck(): HealthCheckProviderDTO.Output {
    return Promise.resolve(
      success({
        status: CacheHealthStatus.HEALTHY,
        driver: CacheDriver.NOOP,
        checkedAt: new Date(),
        master: { reachable: true, latencyInMs: 0, role: 'noop' },
        replicas: [],
        memory: { usedBytes: 0, maxBytes: null, usedPercentage: null, evictedKeys: 0 },
        clients: { connected: 0, blocked: 0, rejectedTotal: 0 },
        server: { version: 'noop', uptimeInSeconds: 0 }
      })
    )
  }
}
