import { type CacheModuleFactoryOptions } from '@ruguin/cache'
import { cacheENV } from '@ruguin/env'

export function createCacheModuleOptions(environment: typeof cacheENV = cacheENV): CacheModuleFactoryOptions {
  return {
    breaker: {
      resetTimeoutInMs: environment.CACHE_BREAKER_RESET_TIMEOUT_MS,
      failureThreshold: environment.CACHE_BREAKER_FAILURE_THRESHOLD
    },

    driver: environment.CACHE_DRIVER,
    jitterRatio: environment.CACHE_JITTER_RATIO,
    defaultTtlInMs: environment.CACHE_DEFAULT_TTL_MS,
    defaultConsistency: environment.CACHE_DEFAULT_CONSISTENCY,
    invalidationBroadcast: environment.CACHE_INVALIDATION_BROADCAST,

    prefix: environment.CACHE_PREFIX,
    negativeTtlInMs: environment.CACHE_NEGATIVE_TTL_MS,
    lockTtlInMs: environment.CACHE_OPERATION_TIMEOUT_MS * 10,
    operationTimeoutInMs: environment.CACHE_OPERATION_TIMEOUT_MS,
    namespaceVersionLocalTtlInMs: environment.CACHE_NS_VERSION_LOCAL_TTL_MS,
    replicationLagThresholdInBytes: environment.CACHE_REPLICATION_LAG_THRESHOLD_BYTES,

    ...(environment.CACHE_MASTER_URL !== undefined && {
      masterUrl: environment.CACHE_MASTER_URL
    }),

    ...(environment.CACHE_REPLICA_URLS.length > 0 && {
      replicaUrls: environment.CACHE_REPLICA_URLS
    })
  }
}
