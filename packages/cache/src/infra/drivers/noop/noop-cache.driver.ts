import { success } from '@ruguin/utils'

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
  type ReleaseLockProviderDTO,
  type RemoveScoreProviderDTO,
  type ResolveNamespaceVersionProviderDTO,
  type SetCacheProviderDTO,
  type SetIfNotExistsCacheProviderDTO,
  type SetScoreProviderDTO
} from '../../../domain'

const NOOP_TOKEN = 'noop'

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

  public acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    const expiresAt: Date = new Date(Date.now() + input.ttlInMs)

    return Promise.resolve(success({ token: NOOP_TOKEN, expiresAt }))
  }

  public release(): ReleaseLockProviderDTO.Output {
    return Promise.resolve(success({ released: true }))
  }

  public extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output {
    const expiresAt: Date = new Date(Date.now() + input.ttlInMs)

    return Promise.resolve(success({ expiresAt }))
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
