import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { lazyEnvironment } from '../shared/lazy-environment.ts'

export const tokenProviderENV = lazyEnvironment(() =>
  createEnv({
    server: {
      JWT_ACCESS_TOKEN_SECRET: z.string().min(1),
      JWT_REFRESH_TOKEN_SECRET: z.string().min(1),
      JWT_ISSUER: z.string().min(1).default('ruguin-iam'),
      JWT_AUDIENCE: z.string().min(1).default('ruguin-clients'),
      JWT_ALGORITHM: z.enum(['HS256', 'RS256', 'ES256', 'PS256', 'ES384', 'PS384', 'ES512', 'PS512']).default('HS256'),
      JWT_ACCESS_TOKEN_EXPIRES_IN: z.coerce.number().int().positive().default(5),
      JWT_REFRESH_TOKEN_EXPIRES_IN: z.coerce.number().int().positive().default(30),
      JWT_REFRESH_TOKEN_EXPIRES_UNIT: z.enum(['days', 'hours', 'minutes']).default('days'),
      JWT_ACCESS_TOKEN_EXPIRES_UNIT: z.enum(['days', 'hours', 'minutes']).default('minutes')
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
