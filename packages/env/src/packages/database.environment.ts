import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const databaseENV = createEnv({
  server: {
    DATABASE_URL: z.url()
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true
})
