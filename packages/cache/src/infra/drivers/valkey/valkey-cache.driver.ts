import { failure, success } from '@ruguin/utils'

import { type OnCacheError } from '../../../application/on-cache-error.ts'
import {
  type AcquireLockProviderDTO,
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
} from '../../../domain/index.ts'
import { type NamespaceVersionResolver } from '../../namespace-version.resolver.ts'

import { type ValkeyConnectionManager } from './connection/valkey-connection.manager.ts'
import { type InvalidationSubscriber } from './invalidation/invalidation-subscriber.ts'
import { type CounterOperations } from './operations/counter.operations.ts'
import { type HealthOperations } from './operations/health.operations.ts'
import { type KeyValueOperations } from './operations/key-value.operations.ts'
import { type LockOperations } from './operations/lock.operations.ts'
import { type NamespaceOperations } from './operations/namespace.operations.ts'
import { type ScoreOperations } from './operations/score.operations.ts'

/*
 * The driver owns no logic of its own: it routes each leaf contract to the operation object that
 * speaks that concern. Keeping the concerns apart is what stops this from becoming the god class
 * ICacheDriver's twenty-two methods invite — the split lives here, the conveniences live in
 * CacheProviderFacade.
 */
export class ValkeyCacheDriver implements ICacheDriver {
  private readonly connections: ValkeyConnectionManager
  private readonly counters: CounterOperations
  private readonly health: HealthOperations
  private readonly keyValue: KeyValueOperations
  private readonly locks: LockOperations
  private readonly namespaces: NamespaceOperations
  private readonly onCacheError: OnCacheError
  private readonly scores: ScoreOperations
  private readonly subscriber: InvalidationSubscriber | null
  private readonly versions: NamespaceVersionResolver

  constructor(input: {
    connections: ValkeyConnectionManager
    counters: CounterOperations
    health: HealthOperations
    keyValue: KeyValueOperations
    locks: LockOperations
    namespaces: NamespaceOperations
    onCacheError: OnCacheError
    scores: ScoreOperations
    subscriber: InvalidationSubscriber | null
    versions: NamespaceVersionResolver
  }) {
    this.connections = input.connections
    this.counters = input.counters
    this.health = input.health
    this.keyValue = input.keyValue
    this.locks = input.locks
    this.namespaces = input.namespaces
    this.onCacheError = input.onCacheError
    this.scores = input.scores
    this.subscriber = input.subscriber
    this.versions = input.versions
  }

  public async connect(): ConnectProviderDTO.Output {
    const connected = await this.connections.connect()
    if (connected.isFailure()) return failure(connected.value)

    if (this.subscriber !== null) {
      const started = await this.subscriber.start()

      /*
       * A subscriber that will not come up costs the broadcast, not the cache. The memo TTL is
       * still the ceiling on the eventual window and strong mode still has no window at all, so
       * this degrades rather than refusing to connect.
       */
      if (started.isFailure()) {
        this.onCacheError({ error: started.value, key: '', namespace: '', operation: 'connect' })
      }
    }

    return success({ connected: true })
  }

  public async disconnect(): DisconnectProviderDTO.Output {
    const disconnected = await this.connections.disconnect()
    if (disconnected.isFailure()) return failure(disconnected.value)

    this.versions.clearMemo()

    return success({ disconnected: true })
  }

  public get<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    return this.keyValue.get<T>(input)
  }

  public set<T>(input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output {
    return this.keyValue.set<T>(input)
  }

  public delete(input: DeleteCacheProviderDTO.Input): DeleteCacheProviderDTO.Output {
    return this.keyValue.delete(input)
  }

  public setIfNotExists<T>(input: SetIfNotExistsCacheProviderDTO.Input<T>): SetIfNotExistsCacheProviderDTO.Output {
    return this.keyValue.setIfNotExists<T>(input)
  }

  public increment(input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output {
    return this.counters.increment(input)
  }

  public decrement(input: DecrementCounterProviderDTO.Input): DecrementCounterProviderDTO.Output {
    return this.counters.decrement(input)
  }

  public getCounter(input: GetCounterProviderDTO.Input): GetCounterProviderDTO.Output {
    return this.counters.getCounter(input)
  }

  public acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    return this.locks.acquire(input)
  }

  public release(input: ReleaseLockProviderDTO.Input): ReleaseLockProviderDTO.Output {
    return this.locks.release(input)
  }

  public extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output {
    return this.locks.extend(input)
  }

  public setScore(input: SetScoreProviderDTO.Input): SetScoreProviderDTO.Output {
    return this.scores.setScore(input)
  }

  public incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output {
    return this.scores.incrementScore(input)
  }

  public getScore(input: GetScoreProviderDTO.Input): GetScoreProviderDTO.Output {
    return this.scores.getScore(input)
  }

  public getRank(input: GetRankProviderDTO.Input): GetRankProviderDTO.Output {
    return this.scores.getRank(input)
  }

  public getTopScores(input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output {
    return this.scores.getTopScores(input)
  }

  public removeScore(input: RemoveScoreProviderDTO.Input): RemoveScoreProviderDTO.Output {
    return this.scores.removeScore(input)
  }

  public countScores(input: CountScoresProviderDTO.Input): CountScoresProviderDTO.Output {
    return this.scores.countScores(input)
  }

  public async invalidateNamespace(input: InvalidateNamespaceProviderDTO.Input): InvalidateNamespaceProviderDTO.Output {
    const invalidated = await this.namespaces.invalidate(input)
    if (invalidated.isFailure()) return failure(invalidated.value)

    /*
     * Our own memo, updated without waiting for our own message to loop back through Pub/Sub.
     * Skipping this would leave the instance that performed the invalidation as the last one to
     * learn about it, for as long as the round trip takes.
     */
    this.versions.applyBroadcast({ namespace: input.namespace, version: invalidated.value.version })

    return success({ version: invalidated.value.version })
  }

  public resolveNamespaceVersion(
    input: ResolveNamespaceVersionProviderDTO.Input
  ): ResolveNamespaceVersionProviderDTO.Output {
    return this.versions.resolveNamespaceVersion(input)
  }

  public healthCheck(input?: HealthCheckProviderDTO.Input): HealthCheckProviderDTO.Output {
    return this.health.check(input)
  }
}
