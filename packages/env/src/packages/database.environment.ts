import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { lazyEnvironment as lazyEnvironmentironment } from '../shared/lazy-environment.ts'

export const databaseENV = lazyEnvironmentironment(() =>
  createEnv({
    server: {
      DATABASE_URL: z.url()
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
