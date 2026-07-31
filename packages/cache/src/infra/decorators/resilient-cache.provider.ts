import { type Either, failure, success } from '@ruguin/utils'

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
  LockNotAcquiredError,
  LockNotOwnedError,
  type ReleaseLockProviderDTO,
  type RemoveScoreProviderDTO,
  type ResolveNamespaceVersionProviderDTO,
  type SetCacheProviderDTO,
  type SetIfNotExistsCacheProviderDTO,
  type SetScoreProviderDTO
} from '../../domain'

import { CircuitBreaker } from './circuit-breaker'

const INITIAL_VERSION = 1

const lockKeyOf = (input: { key: string; namespace: string }): string => `${input.namespace}:__lock__:${input.key}`

/*
 * Wraps an ICacheDriver, not an ICacheProvider, and that is what makes getOrSet feel the breaker:
 * cache-aside reads and writes through this same chain, so an open circuit turns its read into
 * an instant miss and the orchestrator goes straight to the loader without paying a timeout.
 *
 * Without a breaker, fail-open is not enough on its own — every request still waits out the
 * connection timeout before falling through, so a dead cache makes the API slow rather than
 * merely uncached.
 */
export class ResilientCacheProvider implements ICacheDriver {
  private readonly breaker: CircuitBreaker
  private readonly inner: ICacheDriver

  constructor(input: {
    breaker?: CircuitBreaker
    failureThreshold: number
    inner: ICacheDriver
    resetTimeoutInMs: number
  }) {
    this.inner = input.inner
    this.breaker =
      input.breaker ??
      new CircuitBreaker({ failureThreshold: input.failureThreshold, resetTimeoutInMs: input.resetTimeoutInMs })
  }

  public get<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    return this.guard({
      execute: () => this.inner.get<T>(input),
      fallback: () => success({ found: false, value: null })
    })
  }

  public set<T>(input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output {
    /*
     * A dropped write is safe: the source of truth still holds the value and the only loss is
     * the benefit of the cache. A dropped write that *reported* failure would not be.
     */
    return this.guard({
      execute: () => this.inner.set<T>(input),
      fallback: () => success({ expiresAt: new Date() })
    })
  }

  public delete(input: DeleteCacheProviderDTO.Input): DeleteCacheProviderDTO.Output {
    return this.guard({ execute: () => this.inner.delete(input), fallback: () => success({ existed: false }) })
  }

  public setIfNotExists<T>(input: SetIfNotExistsCacheProviderDTO.Input<T>): SetIfNotExistsCacheProviderDTO.Output {
    /*
     * `stored: true`, matching the noop driver: a caller guarding a side effect on this will do
     * the work rather than skip it forever. Duplicated work is the safe failure here; omitted
     * work is not.
     */
    return this.guard({
      execute: () => this.inner.setIfNotExists<T>(input),
      fallback: () => success({ stored: true })
    })
  }

  public increment(input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output {
    return this.guard({ execute: () => this.inner.increment(input), fallback: () => success({ value: 0 }) })
  }

  public decrement(input: DecrementCounterProviderDTO.Input): DecrementCounterProviderDTO.Output {
    return this.guard({ execute: () => this.inner.decrement(input), fallback: () => success({ value: 0 }) })
  }

  public getCounter(input: GetCounterProviderDTO.Input): GetCounterProviderDTO.Output {
    return this.guard({ execute: () => this.inner.getCounter(input), fallback: () => success({ value: 0 }) })
  }

  public acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    /*
     * Refused, never granted, for the same reason the noop driver refuses. Handing out a token
     * while skipping I/O would invent mutual exclusion out of an outage, and every concurrent
     * caller of executeWithLock would be told it holds the lock alone.
     */
    return this.guard({
      execute: () => this.inner.acquire(input),
      fallback: () => failure(new LockNotAcquiredError({ attempts: 0, lockKey: lockKeyOf(input) }))
    })
  }

  public release(input: ReleaseLockProviderDTO.Input): ReleaseLockProviderDTO.Output {
    // Nothing was granted, so nothing is held: `released: false` rather than noise in onCacheError.
    return this.guard({ execute: () => this.inner.release(input), fallback: () => success({ released: false }) })
  }

  public extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output {
    // The success shape is a bare expiresAt, and there is no honest Date for a lock never granted.
    return this.guard({
      execute: () => this.inner.extend(input),
      fallback: () => failure(new LockNotOwnedError({ lockKey: lockKeyOf(input) }))
    })
  }

  public setScore(input: SetScoreProviderDTO.Input): SetScoreProviderDTO.Output {
    return this.guard({ execute: () => this.inner.setScore(input), fallback: () => success({ created: false }) })
  }

  public incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output {
    return this.guard({ execute: () => this.inner.incrementScore(input), fallback: () => success({ score: input.by }) })
  }

  public getScore(input: GetScoreProviderDTO.Input): GetScoreProviderDTO.Output {
    return this.guard({ execute: () => this.inner.getScore(input), fallback: () => success({ score: null }) })
  }

  public getRank(input: GetRankProviderDTO.Input): GetRankProviderDTO.Output {
    return this.guard({ execute: () => this.inner.getRank(input), fallback: () => success({ rank: null, total: 0 }) })
  }

  public getTopScores(input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output {
    return this.guard({ execute: () => this.inner.getTopScores(input), fallback: () => success({ entries: [] }) })
  }

  public removeScore(input: RemoveScoreProviderDTO.Input): RemoveScoreProviderDTO.Output {
    return this.guard({ execute: () => this.inner.removeScore(input), fallback: () => success({ removed: false }) })
  }

  public countScores(input: CountScoresProviderDTO.Input): CountScoresProviderDTO.Output {
    return this.guard({ execute: () => this.inner.countScores(input), fallback: () => success({ total: 0 }) })
  }

  /*
   * Recorded but never short-circuited. Answering "invalidated" without touching the server
   * would be the one lie the breaker cannot afford: other instances keep serving the version
   * this call was supposed to retire, and the caller has been told otherwise.
   */
  public invalidateNamespace(input: InvalidateNamespaceProviderDTO.Input): InvalidateNamespaceProviderDTO.Output {
    return this.record(() => this.inner.invalidateNamespace(input))
  }

  public resolveNamespaceVersion(
    input: ResolveNamespaceVersionProviderDTO.Input
  ): ResolveNamespaceVersionProviderDTO.Output {
    /*
     * Version 1 while open, matching the "never read it" default. It can address a version the
     * server has moved past, which costs a miss on reads and an unreachable key on writes — both
     * already accepted by spec §6, and both cheaper than waiting out a timeout per operation.
     */
    return this.guard({
      execute: () => this.inner.resolveNamespaceVersion(input),
      fallback: () => success({ version: INITIAL_VERSION })
    })
  }

  /*
   * Lifecycle and diagnostics pass through untouched and unrecorded. Short-circuiting the health
   * check would make the breaker hide the very outage it is reacting to, which is the one report
   * an operator needs to be true.
   */
  public connect(): ConnectProviderDTO.Output {
    return this.inner.connect()
  }

  public disconnect(): DisconnectProviderDTO.Output {
    return this.inner.disconnect()
  }

  public healthCheck(input?: HealthCheckProviderDTO.Input): HealthCheckProviderDTO.Output {
    return this.inner.healthCheck(input)
  }

  public state(): ReturnType<CircuitBreaker['currentState']> {
    return this.breaker.currentState()
  }

  private async guard<F, S>(input: {
    execute: () => Promise<Either<F, S>>
    fallback: () => Either<F, S>
  }): Promise<Either<F, S>> {
    if (this.breaker.shouldSkip()) return input.fallback()

    return this.record(input.execute)
  }

  private async record<F, S>(execute: () => Promise<Either<F, S>>): Promise<Either<F, S>> {
    const result: Either<F, S> = await execute()

    if (result.isFailure()) {
      this.breaker.recordFailure()
    } else {
      this.breaker.recordSuccess()
    }

    return result
  }
}
