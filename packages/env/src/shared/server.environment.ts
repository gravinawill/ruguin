import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { lazyEnvironment as lazy } from './lazy-environment.ts'

export const EnvironmentEnum = {
  TEST: 'test',
  LOCAL: 'local',
  DEVELOP: 'develop',
  STAGING: 'staging',
  PRODUCTION: 'production'
} as const

export type Environment = (typeof EnvironmentEnum)[keyof typeof EnvironmentEnum]

export const serverENV = lazy(() =>
  createEnv({
    server: {
      ENVIRONMENT: z.enum(Object.values(EnvironmentEnum)),
      PORT: z.coerce.number().int().positive().default(3000)
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
