import { type CacheModuleFactoryOptions } from '@ruguin/cache/nestjs'
import { type cacheENV } from '@ruguin/env/cache'

/*
 * The seam between the validated environment and the framework-agnostic package. It lives in the
 * app, not in @ruguin/cache: the package must stay usable by a worker that gets its configuration
 * from somewhere else entirely, and pulling @ruguin/env into it would decide that question for
 * every future consumer.
 *
 * Takes the environment as an argument, in the same shape as createPinoHttpOptions, so a test can
 * hand it a fabricated one instead of mutating process.env.
 */
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
    /*
     * Not an environment variable of its own: the lock TTL is an upper bound on how long a stampede
     * winner may hold the key, and the operation timeout is what the losers wait through. Ten times
     * the timeout leaves room for a slow loader without letting a crashed holder block the namespace
     * for a noticeable stretch.
     */
    lockTtlInMs: environment.CACHE_OPERATION_TIMEOUT_MS * 10,
    namespaceVersionLocalTtlInMs: environment.CACHE_NS_VERSION_LOCAL_TTL_MS,
    negativeTtlInMs: environment.CACHE_NEGATIVE_TTL_MS,
    operationTimeoutInMs: environment.CACHE_OPERATION_TIMEOUT_MS,
    prefix: environment.CACHE_PREFIX,
    replicationLagThresholdInBytes: environment.CACHE_REPLICATION_LAG_THRESHOLD_BYTES,
    /*
     * Conditional spread rather than `masterUrl: environment.CACHE_MASTER_URL`: this app compiles
     * with exactOptionalPropertyTypes, under which an optional property will not accept an explicit
     * undefined.
     */
    ...(environment.CACHE_MASTER_URL !== undefined && { masterUrl: environment.CACHE_MASTER_URL }),
    ...(environment.CACHE_REPLICA_URLS.length > 0 && { replicaUrls: environment.CACHE_REPLICA_URLS })
  }
}
