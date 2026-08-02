import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { lazyEnvironment } from '../shared/lazy-environment.ts'

export const databaseENV = lazyEnvironment(() =>
  createEnv({
    server: {
      DATABASE_URL: z.url()
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
