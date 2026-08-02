import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { lazyEnvironment as lazyEnvironmentironment } from './lazy-environment.ts'

export const EnvironmentEnum = {
  TEST: 'test',
  LOCAL: 'local',
  DEVELOP: 'develop',
  STAGING: 'staging',
  PRODUCTION: 'production'
} as const

export type Environment = (typeof EnvironmentEnum)[keyof typeof EnvironmentEnum]

export const serverENV = lazyEnvironmentironment(() =>
  createEnv({
    server: {
      ENVIRONMENT: z.enum(Object.values(EnvironmentEnum)),
      /*
       * Default de propósito: os apps que ainda não expõem HTTP não precisam declarar PORT, e
       * tornar isto obrigatório quebraria o boot de todos eles.
       */
      PORT: z.coerce.number().int().positive().default(3000)
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
