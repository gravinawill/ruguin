import { type Attributes, type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api'
import { type Either } from '@ruguin/utils'

import {
  type AcquireLockProviderDTO,
  type CacheDriver,
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
} from '../../domain'

const TRACER_NAME = '@ruguin/cache'

/*
 * Applied outside the breaker — observable(resilient(driver)) — so a call the breaker
 * short-circuited still produces a span. Ordering it the other way round would make the cache
 * look silent precisely when it is failing, which is the moment the trace matters most.
 */
export class ObservableCacheProvider implements ICacheDriver {
  private readonly driver: CacheDriver
  private readonly inner: ICacheDriver
  private readonly tracer: Tracer

  constructor(input: { driver: CacheDriver; inner: ICacheDriver; tracer?: Tracer }) {
    this.driver = input.driver
    this.inner = input.inner
    this.tracer = input.tracer ?? trace.getTracer(TRACER_NAME)
  }

  public get<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    return this.observe({
      describe: (value) => ({ 'cache.hit': value.found }),
      execute: () => this.inner.get<T>(input),
      namespace: input.namespace,
      operation: 'get'
    })
  }

  public set<T>(input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output {
    return this.observe({ execute: () => this.inner.set<T>(input), namespace: input.namespace, operation: 'set' })
  }

  public delete(input: DeleteCacheProviderDTO.Input): DeleteCacheProviderDTO.Output {
    return this.observe({ execute: () => this.inner.delete(input), namespace: input.namespace, operation: 'delete' })
  }

  public setIfNotExists<T>(input: SetIfNotExistsCacheProviderDTO.Input<T>): SetIfNotExistsCacheProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.setIfNotExists<T>(input),
      namespace: input.namespace,
      operation: 'setIfNotExists'
    })
  }

  public increment(input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.increment(input),
      namespace: input.namespace,
      operation: 'increment'
    })
  }

  public decrement(input: DecrementCounterProviderDTO.Input): DecrementCounterProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.decrement(input),
      namespace: input.namespace,
      operation: 'decrement'
    })
  }

  public getCounter(input: GetCounterProviderDTO.Input): GetCounterProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.getCounter(input),
      namespace: input.namespace,
      operation: 'getCounter'
    })
  }

  public acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    return this.observe({ execute: () => this.inner.acquire(input), namespace: input.namespace, operation: 'acquire' })
  }

  public release(input: ReleaseLockProviderDTO.Input): ReleaseLockProviderDTO.Output {
    return this.observe({ execute: () => this.inner.release(input), namespace: input.namespace, operation: 'release' })
  }

  public extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output {
    return this.observe({ execute: () => this.inner.extend(input), namespace: input.namespace, operation: 'extend' })
  }

  public setScore(input: SetScoreProviderDTO.Input): SetScoreProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.setScore(input),
      namespace: input.namespace,
      operation: 'setScore'
    })
  }

  public incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.incrementScore(input),
      namespace: input.namespace,
      operation: 'incrementScore'
    })
  }

  public getScore(input: GetScoreProviderDTO.Input): GetScoreProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.getScore(input),
      namespace: input.namespace,
      operation: 'getScore'
    })
  }

  public getRank(input: GetRankProviderDTO.Input): GetRankProviderDTO.Output {
    return this.observe({ execute: () => this.inner.getRank(input), namespace: input.namespace, operation: 'getRank' })
  }

  public getTopScores(input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.getTopScores(input),
      namespace: input.namespace,
      operation: 'getTopScores'
    })
  }

  public removeScore(input: RemoveScoreProviderDTO.Input): RemoveScoreProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.removeScore(input),
      namespace: input.namespace,
      operation: 'removeScore'
    })
  }

  public countScores(input: CountScoresProviderDTO.Input): CountScoresProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.countScores(input),
      namespace: input.namespace,
      operation: 'countScores'
    })
  }

  public invalidateNamespace(input: InvalidateNamespaceProviderDTO.Input): InvalidateNamespaceProviderDTO.Output {
    return this.observe({
      describe: (value) => ({ 'cache.namespace.version': value.version }),
      execute: () => this.inner.invalidateNamespace(input),
      namespace: input.namespace,
      operation: 'invalidateNamespace'
    })
  }

  public resolveNamespaceVersion(
    input: ResolveNamespaceVersionProviderDTO.Input
  ): ResolveNamespaceVersionProviderDTO.Output {
    return this.observe({
      describe: (value) => ({ 'cache.namespace.version': value.version }),
      execute: () => this.inner.resolveNamespaceVersion(input),
      namespace: input.namespace,
      operation: 'resolveNamespaceVersion'
    })
  }

  public connect(): ConnectProviderDTO.Output {
    return this.observe({ execute: () => this.inner.connect(), operation: 'connect' })
  }

  public disconnect(): DisconnectProviderDTO.Output {
    return this.observe({ execute: () => this.inner.disconnect(), operation: 'disconnect' })
  }

  public healthCheck(input?: HealthCheckProviderDTO.Input): HealthCheckProviderDTO.Output {
    return this.observe({
      describe: (value) => ({ 'cache.health.status': value.status }),
      execute: () => this.inner.healthCheck(input),
      operation: 'healthCheck'
    })
  }

  private async observe<F, S>(input: {
    describe?: (value: S) => Attributes
    execute: () => Promise<Either<F, S>>
    namespace?: string
    operation: string
  }): Promise<Either<F, S>> {
    const attributes: Attributes = { 'cache.driver': this.driver, 'cache.operation': input.operation }
    if (input.namespace !== undefined) attributes['cache.namespace'] = input.namespace

    const span: Span = this.tracer.startSpan(`cache.${input.operation}`, { attributes })

    try {
      const result: Either<F, S> = await input.execute()

      if (result.isFailure()) {
        span.setAttribute('cache.outcome', 'error')
        span.setStatus({ code: SpanStatusCode.ERROR })
      } else {
        span.setAttribute('cache.outcome', 'ok')
        if (input.describe !== undefined) span.setAttributes(input.describe(result.value))
      }

      return result
    } finally {
      span.end()
    }
  }
}
