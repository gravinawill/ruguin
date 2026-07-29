import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const cacheENV = createEnv({
  server: {
    CACHE_PREFIX: z.string().min(1),
    CACHE_DRIVER: z.enum(['memory', 'noop']).default('memory'),
    CACHE_DEFAULT_TTL_MS: z.coerce.number().int().positive().default(300_000),
    CACHE_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.1),
    CACHE_NEGATIVE_TTL_MS: z.coerce.number().int().positive().default(30_000),
    CACHE_NS_VERSION_LOCAL_TTL_MS: z.coerce.number().int().nonnegative().default(5000)
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true
})
