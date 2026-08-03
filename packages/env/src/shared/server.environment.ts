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
      /*
       * Default de propósito: os apps que ainda não expõem HTTP não precisam declarar PORT, e
       * tornar isto obrigatório quebraria o boot de todos eles.
       *
       * 3333 e não 3000 porque o Grafana do docker-compose local ocupa a 3000 — com o default
       * anterior o serviço subia, falhava no listen e morria com EADDRINUSE sempre que a stack
       * de observabilidade estivesse de pé.
       */
      PORT: z.coerce.number().int().positive().default(3333)
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
