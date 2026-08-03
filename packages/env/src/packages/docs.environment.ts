import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { lazyEnvironment } from '../shared/lazy-environment.ts'

export const docsENV = lazyEnvironment(() =>
  createEnv({
    server: {
      DOCS_USERNAME: z.string().min(1),
      DOCS_PASSWORD: z.string().min(1)
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
