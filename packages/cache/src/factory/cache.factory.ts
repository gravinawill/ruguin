import { type Either, failure, success } from '@ruguin/utils'
import { type RedisOptions } from 'iovalkey'

import { CacheProviderFacade, ExecuteWithLockProvider, GetOrSetCacheProvider, type OnCacheError } from '../application'
import {
  type CacheConsistency,
  CacheDriver,
  type ICacheDriver,
  type ICacheProvider,
  InvalidCacheConfigError
} from '../domain'
import {
  JsonSerializerStrategy,
  KeyBuilder,
  MemoryCacheDriver,
  type NamespaceConfig,
  NoopCacheDriver,
  ObservableCacheProvider,
  ResilientCacheProvider
} from '../infra'

import { createValkeyDriver } from './create-valkey-driver'

export namespace CacheFactoryDTO {
  export type Config = Readonly<{
    breaker: Readonly<{ failureThreshold: number; resetTimeoutInMs: number }>
    connectionOptions?: RedisOptions
    defaultConsistency: CacheConsistency
    defaultTtlInMs: number
    driver: CacheDriver
    invalidationBroadcast: boolean
    jitterRatio: number
    lockTtlInMs: number
    masterUrl?: string
    namespaces?: NamespaceConfig
    namespaceVersionLocalTtlInMs: number
    negativeTtlInMs: number
    observability?: boolean
    onCacheError: OnCacheError
    operationTimeoutInMs: number
    prefix: string
    replicaUrls?: readonly string[]
    replicationLagThresholdInBytes: number
  }>

  export type OutputError = Readonly<InvalidCacheConfigError>

  export type Output = Either<OutputError, ICacheProvider>
}

const buildDriver = (input: CacheFactoryDTO.Config): Either<InvalidCacheConfigError, ICacheDriver> => {
  if (input.driver === CacheDriver.NOOP) return success(new NoopCacheDriver())

  const keyBuilder = new KeyBuilder({ prefix: input.prefix })
  const serializer = new JsonSerializerStrategy()

  if (input.driver === CacheDriver.MEMORY) {
    return success(
      new MemoryCacheDriver({
        defaultTtlInMs: input.defaultTtlInMs,
        jitterRatio: input.jitterRatio,
        keyBuilder,
        serializer
      })
    )
  }

  const masterUrl: string | undefined = input.masterUrl
  if (masterUrl === undefined || masterUrl.length === 0) {
    return failure(
      new InvalidCacheConfigError({
        reason: 'a master url is required when the driver is "valkey"',
        setting: 'masterUrl'
      })
    )
  }

  return success(
    createValkeyDriver({
      defaultConsistency: input.defaultConsistency,
      defaultTtlInMs: input.defaultTtlInMs,
      invalidationBroadcast: input.invalidationBroadcast,
      jitterRatio: input.jitterRatio,
      keyBuilder,
      masterUrl,
      namespaces: input.namespaces ?? {},
      namespaceVersionLocalTtlInMs: input.namespaceVersionLocalTtlInMs,
      onCacheError: input.onCacheError,
      operationTimeoutInMs: input.operationTimeoutInMs,
      prefix: input.prefix,
      replicaUrls: input.replicaUrls ?? [],
      replicationLagThresholdInBytes: input.replicationLagThresholdInBytes,
      serializer,
      ...(input.connectionOptions !== undefined && { connectionOptions: input.connectionOptions })
    })
  )
}

/*
 * observable(resilient(driver)), in that order. The span therefore covers the breaker's own
 * decision, including the calls it short-circuits — reversed, the trace would fall silent at
 * exactly the moment someone is reading it to find out why the cache stopped helping.
 */
const decorate = (input: { config: CacheFactoryDTO.Config; driver: ICacheDriver }): ICacheDriver => {
  const resilient: ICacheDriver = new ResilientCacheProvider({
    failureThreshold: input.config.breaker.failureThreshold,
    inner: input.driver,
    resetTimeoutInMs: input.config.breaker.resetTimeoutInMs
  })

  if (input.config.observability === false) return resilient

  return new ObservableCacheProvider({ driver: input.config.driver, inner: resilient })
}

/*
 * The single composition root. Every wiring decision the package makes — which driver family,
 * which decorators, which orchestrators sit on top — is spelled out once here, so a service that
 * wants a cache asks for one instead of assembling twelve objects in the right order.
 *
 * An object rather than a class with static methods: there is no instance state to hold, and a
 * class that never gets constructed is a namespace wearing a costume.
 */
export const CacheFactory = {
  create: (input: CacheFactoryDTO.Config): CacheFactoryDTO.Output => {
    const driver = buildDriver(input)
    if (driver.isFailure()) return failure(driver.value)

    const decorated: ICacheDriver = decorate({ config: input, driver: driver.value })

    /*
     * Both orchestrators receive the *decorated* driver, not the raw one. That is what makes
     * getOrSet's read see the breaker: an open circuit turns it into an instant miss and
     * cache-aside falls through to the loader without paying a timeout.
     */
    return success(
      new CacheProviderFacade({
        driver: decorated,
        executeWithLockProvider: new ExecuteWithLockProvider({
          lockAcquirer: decorated,
          lockReleaser: decorated,
          onCacheError: input.onCacheError
        }),
        getOrSetProvider: new GetOrSetCacheProvider({
          lockAcquirer: decorated,
          lockReleaser: decorated,
          lockTtlInMs: input.lockTtlInMs,
          negativeTtlInMs: input.negativeTtlInMs,
          onCacheError: input.onCacheError,
          reader: decorated,
          writer: decorated
        })
      })
    )
  }
} as const
