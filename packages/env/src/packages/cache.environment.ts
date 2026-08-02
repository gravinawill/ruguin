import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { lazyEnvironment } from '../shared/lazy-environment.ts'

export const cacheENV = lazyEnvironment(() =>
  createEnv({
    server: {
      CACHE_PREFIX: z.string().min(1),
      CACHE_DRIVER: z.enum(['valkey', 'memory', 'noop']).default('memory'),
      CACHE_MASTER_URL: z.url().optional(),
      CACHE_REPLICA_URLS: z
        .string()
        .default('')
        .transform((urls) =>
          urls
            .split(',')
            .map((url) => url.trim())
            .filter((url) => url.length > 0)
        ),
      CACHE_DEFAULT_TTL_MS: z.coerce.number().int().positive().default(300_000),
      CACHE_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.1),
      CACHE_NEGATIVE_TTL_MS: z.coerce.number().int().positive().default(30_000),
      CACHE_NS_VERSION_LOCAL_TTL_MS: z.coerce.number().int().nonnegative().default(5000),
      CACHE_DEFAULT_CONSISTENCY: z.enum(['eventual', 'strong']).default('eventual'),
      CACHE_INVALIDATION_BROADCAST: z.stringbool().default(true),
      CACHE_OPERATION_TIMEOUT_MS: z.coerce.number().int().positive().default(500),
      CACHE_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
      CACHE_BREAKER_RESET_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
      CACHE_REPLICATION_LAG_THRESHOLD_BYTES: z.coerce.number().int().nonnegative().default(1_048_576)
    },
    createFinalSchema: (shape) =>
      z
        .object(shape)
        .refine((environment) => environment.CACHE_DRIVER !== 'valkey' || environment.CACHE_MASTER_URL !== undefined, {
          message: 'CACHE_MASTER_URL is required when CACHE_DRIVER is "valkey"',
          path: ['CACHE_MASTER_URL']
        }),
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
