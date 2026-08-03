import { type CacheModuleFactoryOptions } from '@ruguin/cache'
import { cacheENV } from '@ruguin/env'

export function createCacheModuleOptions(): CacheModuleFactoryOptions {
  return {
    breaker: {
      resetTimeoutInMs: cacheENV.CACHE_BREAKER_RESET_TIMEOUT_MS,
      failureThreshold: cacheENV.CACHE_BREAKER_FAILURE_THRESHOLD
    },

    driver: cacheENV.CACHE_DRIVER,
    jitterRatio: cacheENV.CACHE_JITTER_RATIO,
    defaultTtlInMs: cacheENV.CACHE_DEFAULT_TTL_MS,
    defaultConsistency: cacheENV.CACHE_DEFAULT_CONSISTENCY,
    invalidationBroadcast: cacheENV.CACHE_INVALIDATION_BROADCAST,

    prefix: cacheENV.CACHE_PREFIX,
    negativeTtlInMs: cacheENV.CACHE_NEGATIVE_TTL_MS,
    lockTtlInMs: cacheENV.CACHE_OPERATION_TIMEOUT_MS * 10,
    operationTimeoutInMs: cacheENV.CACHE_OPERATION_TIMEOUT_MS,
    namespaceVersionLocalTtlInMs: cacheENV.CACHE_NS_VERSION_LOCAL_TTL_MS,
    replicationLagThresholdInBytes: cacheENV.CACHE_REPLICATION_LAG_THRESHOLD_BYTES,

    ...(cacheENV.CACHE_MASTER_URL !== undefined && {
      masterUrl: cacheENV.CACHE_MASTER_URL
    }),

    ...(cacheENV.CACHE_REPLICA_URLS.length > 0 && {
      replicaUrls: cacheENV.CACHE_REPLICA_URLS
    })
  }
}
