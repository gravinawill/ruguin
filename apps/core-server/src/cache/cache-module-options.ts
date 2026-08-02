import { type CacheModuleFactoryOptions } from '@ruguin/cache'
import { type cacheENV } from '@ruguin/env'

export function createCacheModuleOptions(environment: typeof cacheENV): CacheModuleFactoryOptions {
  return {
    breaker: {
      failureThreshold: environment.CACHE_BREAKER_FAILURE_THRESHOLD,
      resetTimeoutInMs: environment.CACHE_BREAKER_RESET_TIMEOUT_MS
    },

    defaultConsistency: environment.CACHE_DEFAULT_CONSISTENCY,
    defaultTtlInMs: environment.CACHE_DEFAULT_TTL_MS,
    driver: environment.CACHE_DRIVER,
    invalidationBroadcast: environment.CACHE_INVALIDATION_BROADCAST,
    jitterRatio: environment.CACHE_JITTER_RATIO,

    lockTtlInMs: environment.CACHE_OPERATION_TIMEOUT_MS * 10,
    namespaceVersionLocalTtlInMs: environment.CACHE_NS_VERSION_LOCAL_TTL_MS,
    negativeTtlInMs: environment.CACHE_NEGATIVE_TTL_MS,
    operationTimeoutInMs: environment.CACHE_OPERATION_TIMEOUT_MS,
    prefix: environment.CACHE_PREFIX,
    replicationLagThresholdInBytes: environment.CACHE_REPLICATION_LAG_THRESHOLD_BYTES,

    ...(environment.CACHE_MASTER_URL !== undefined && { masterUrl: environment.CACHE_MASTER_URL }),
    ...(environment.CACHE_REPLICA_URLS.length > 0 && { replicaUrls: environment.CACHE_REPLICA_URLS })
  }
}
