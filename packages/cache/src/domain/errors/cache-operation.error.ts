import { type CacheConnectionError } from './cache-connection.error.ts'
import { type CacheNotInitializedError } from './cache-not-initialized.error.ts'
import { type CacheTimeoutError } from './cache-timeout.error.ts'
import { type InvalidCacheKeyError } from './invalid-cache-key.error.ts'

export type CacheOperationError =
  CacheConnectionError | CacheTimeoutError | CacheNotInitializedError | InvalidCacheKeyError
