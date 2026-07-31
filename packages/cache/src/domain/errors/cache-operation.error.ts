import { type CacheConnectionError } from './cache-connection.error'
import { type CacheNotInitializedError } from './cache-not-initialized.error'
import { type CacheTimeoutError } from './cache-timeout.error'
import { type InvalidCacheKeyError } from './invalid-cache-key.error'

export type CacheOperationError =
  CacheConnectionError | CacheTimeoutError | CacheNotInitializedError | InvalidCacheKeyError
