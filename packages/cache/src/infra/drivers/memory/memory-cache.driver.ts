import { type Either, failure, success } from '@ruguin/utils'

import {
  type AcquireLockProviderDTO,
  CacheDriver,
  CacheHealthStatus,
  CacheNotInitializedError,
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
  type InvalidCacheKeyError,
  type ISerializerStrategy,
  LockNotAcquiredError,
  LockNotOwnedError,
  type ReleaseLockProviderDTO,
  type RemoveScoreProviderDTO,
  type ResolveNamespaceVersionProviderDTO,
  type SetCacheProviderDTO,
  type SetIfNotExistsCacheProviderDTO,
  type SetScoreProviderDTO
} from '../../../domain'
import { type KeyBuilder } from '../../key-builder'

import { MemoryStore } from './memory.store'

const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

export class MemoryCacheDriver implements ICacheDriver {
  public readonly store: MemoryStore

  private readonly keyBuilder: KeyBuilder
  private readonly serializer: ISerializerStrategy
  private readonly defaultTtlInMs: number
  private readonly jitterRatio: number
  private connected = false

  constructor(input: {
    keyBuilder: KeyBuilder
    serializer: ISerializerStrategy
    defaultTtlInMs: number
    jitterRatio: number
    store?: MemoryStore
  }) {
    this.keyBuilder = input.keyBuilder
    this.serializer = input.serializer
    this.defaultTtlInMs = input.defaultTtlInMs
    this.jitterRatio = input.jitterRatio
    this.store = input.store ?? new MemoryStore()
  }

  public connect(): ConnectProviderDTO.Output {
    this.connected = true
    return Promise.resolve(success({ connected: true }))
  }

  public disconnect(): DisconnectProviderDTO.Output {
    this.connected = false
    this.store.clear()
    return Promise.resolve(success({ disconnected: true }))
  }

  public get<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'get' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    const raw: string | null = this.store.getValue({ key: key.value })
    if (raw === null) return Promise.resolve(success({ found: false, value: null }))

    const deserialized = this.serializer.deserialize<T>({ raw })

    /*
     * A corrupt entry is a miss, not an outage. Deleting it matters: leaving it in place
     * would make every later read re-parse the same broken payload and re-fail until the
     * TTL runs out, so one bad write would poison the key for its whole lifetime.
     */
    if (deserialized.isFailure()) {
      this.store.deleteValue({ key: key.value })
      return Promise.resolve(success({ found: false, value: null }))
    }

    if (input.validate !== undefined && !input.validate(deserialized.value.value)) {
      return Promise.resolve(success({ found: false, value: null }))
    }

    return Promise.resolve(success({ found: true, value: deserialized.value.value }))
  }

  public set<T>(input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'set' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    const serialized = this.serializer.serialize({ value: input.value })
    if (serialized.isFailure()) return Promise.resolve(failure(serialized.value))

    const ttlInMs: number = this.effectiveTtl({ ttlInMs: input.ttlInMs, applyJitter: input.applyJitter })
    this.store.setValue({ key: key.value, serialized: serialized.value.serialized, ttlInMs })

    const expiresAt: Date = new Date(Date.now() + ttlInMs)

    return Promise.resolve(success({ expiresAt }))
  }

  public delete(input: DeleteCacheProviderDTO.Input): DeleteCacheProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'delete' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    return Promise.resolve(success({ existed: this.store.deleteValue({ key: key.value }) }))
  }

  public setIfNotExists<T>(input: SetIfNotExistsCacheProviderDTO.Input<T>): SetIfNotExistsCacheProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'setIfNotExists' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    const serialized = this.serializer.serialize({ value: input.value })
    if (serialized.isFailure()) return Promise.resolve(failure(serialized.value))

    const wasStored: boolean = this.store.setValueIfAbsent({
      key: key.value,
      serialized: serialized.value.serialized,
      ttlInMs: input.ttlInMs
    })

    return Promise.resolve(success({ stored: wasStored }))
  }

  public increment(input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'increment' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    return Promise.resolve(
      success({
        value: this.store.incrementCounter({ key: key.value, by: input.by ?? 1, ttlInMs: input.ttlInMs })
      })
    )
  }

  public decrement(input: DecrementCounterProviderDTO.Input): DecrementCounterProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'decrement' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    return Promise.resolve(success({ value: this.store.incrementCounter({ key: key.value, by: -(input.by ?? 1) }) }))
  }

  public getCounter(input: GetCounterProviderDTO.Input): GetCounterProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'getCounter' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    return Promise.resolve(success({ value: this.store.getCounter({ key: key.value }) }))
  }

  public async acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    const guard = this.ensureConnected({ operation: 'acquire' })
    if (guard.isFailure()) return failure(guard.value)

    const key = this.keyBuilder.buildLockKey({ namespace: input.namespace, key: input.key })
    if (key.isFailure()) return failure(key.value)

    const attempts: number = input.retry?.attempts ?? 1
    const token: string = crypto.randomUUID()

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (this.store.acquireLock({ key: key.value.physicalKey, token, ttlInMs: input.ttlInMs })) {
        return success({ token, expiresAt: new Date(Date.now() + input.ttlInMs) })
      }

      if (attempt < attempts) await sleep(input.retry?.delayInMs ?? 0)
    }

    return failure(new LockNotAcquiredError({ lockKey: key.value.physicalKey, attempts }))
  }

  public release(input: ReleaseLockProviderDTO.Input): ReleaseLockProviderDTO.Output {
    const key = this.keyBuilder.buildLockKey({ namespace: input.namespace, key: input.key })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    const outcome = this.store.releaseLock({ key: key.value.physicalKey, token: input.token })
    if (outcome === 'not-owned') {
      return Promise.resolve(failure(new LockNotOwnedError({ lockKey: key.value.physicalKey })))
    }

    return Promise.resolve(success({ released: true }))
  }

  public extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output {
    const key = this.keyBuilder.buildLockKey({ namespace: input.namespace, key: input.key })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    const wasExtended: boolean = this.store.extendLock({
      key: key.value.physicalKey,
      token: input.token,
      ttlInMs: input.ttlInMs
    })
    if (!wasExtended) return Promise.resolve(failure(new LockNotOwnedError({ lockKey: key.value.physicalKey })))

    const expiresAt: Date = new Date(Date.now() + input.ttlInMs)

    return Promise.resolve(success({ expiresAt }))
  }

  public setScore(input: SetScoreProviderDTO.Input): SetScoreProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'setScore' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    return Promise.resolve(
      success({
        created: this.store.setScore({
          key: key.value,
          member: input.member,
          score: input.score,
          ttlInMs: input.ttlInMs
        })
      })
    )
  }

  public incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'incrementScore' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    return Promise.resolve(
      success({
        score: this.store.incrementScore({
          key: key.value,
          member: input.member,
          by: input.by,
          ttlInMs: input.ttlInMs
        })
      })
    )
  }

  public getScore(input: GetScoreProviderDTO.Input): GetScoreProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'getScore' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    return Promise.resolve(success({ score: this.store.getScore({ key: key.value, member: input.member }) }))
  }

  public getRank(input: GetRankProviderDTO.Input): GetRankProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'getRank' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    return Promise.resolve(success(this.store.getRankAndTotal({ key: key.value, member: input.member })))
  }

  public getTopScores(input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'getTopScores' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    return Promise.resolve(
      success({
        entries: this.store.getTopScores({ key: key.value, limit: input.limit, offset: input.offset })
      })
    )
  }

  public removeScore(input: RemoveScoreProviderDTO.Input): RemoveScoreProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'removeScore' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    return Promise.resolve(success({ removed: this.store.removeScore({ key: key.value, member: input.member }) }))
  }

  public countScores(input: CountScoresProviderDTO.Input): CountScoresProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'countScores' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    return Promise.resolve(success({ total: this.store.countScores({ key: key.value }) }))
  }

  public invalidateNamespace(input: InvalidateNamespaceProviderDTO.Input): InvalidateNamespaceProviderDTO.Output {
    const guard = this.ensureConnected({ operation: 'invalidateNamespace' })
    if (guard.isFailure()) return Promise.resolve(failure(guard.value))

    return Promise.resolve(success({ version: this.store.bumpVersion({ namespace: input.namespace }) }))
  }

  public resolveNamespaceVersion(
    input: ResolveNamespaceVersionProviderDTO.Input
  ): ResolveNamespaceVersionProviderDTO.Output {
    const guard = this.ensureConnected({ operation: 'resolveNamespaceVersion' })
    if (guard.isFailure()) return Promise.resolve(failure(guard.value))

    return Promise.resolve(success({ version: this.store.getVersion({ namespace: input.namespace }) }))
  }

  public healthCheck(): HealthCheckProviderDTO.Output {
    const guard = this.ensureConnected({ operation: 'healthCheck' })
    if (guard.isFailure()) return Promise.resolve(failure(guard.value))

    return Promise.resolve(
      success({
        status: CacheHealthStatus.HEALTHY,
        driver: CacheDriver.MEMORY,
        checkedAt: new Date(),
        master: { reachable: true, latencyInMs: 0, role: 'memory' },
        replicas: [],
        memory: { usedBytes: 0, maxBytes: null, usedPercentage: null, evictedKeys: 0 },
        clients: { connected: 1, blocked: 0, rejectedTotal: 0 },
        server: { version: 'memory', uptimeInSeconds: 0 }
      })
    )
  }

  private physicalKey(input: {
    namespace: string
    key: string
    operation: string
  }): Either<CacheNotInitializedError | InvalidCacheKeyError, string> {
    const guard = this.ensureConnected({ operation: input.operation })
    if (guard.isFailure()) return failure(guard.value)

    const version: number = this.store.getVersion({ namespace: input.namespace })
    const built = this.keyBuilder.build({ namespace: input.namespace, version, key: input.key })
    if (built.isFailure()) return failure(built.value)

    return success(built.value.physicalKey)
  }

  private ensureConnected(input: { operation: string }): Either<CacheNotInitializedError, true> {
    if (!this.connected) return failure(new CacheNotInitializedError({ operation: input.operation }))

    return success(true)
  }

  private effectiveTtl(input: { ttlInMs?: number; applyJitter?: boolean }): number {
    const base: number = input.ttlInMs ?? this.defaultTtlInMs
    if (input.applyJitter === false || this.jitterRatio === 0) return base

    // Spread expiries so a batch written together does not all die in the same millisecond.
    const spread: number = base * this.jitterRatio

    // eslint-disable-next-line sonarjs/pseudo-random -- TTL jitter is a load-spreading heuristic, not a security primitive
    return Math.max(1, Math.round(base - spread + Math.random() * spread * 2))
  }
}
