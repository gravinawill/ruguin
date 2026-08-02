import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { lazyEnvironment } from '../shared/lazy-environment.ts'

export const awsENV = lazyEnvironment(() =>
  createEnv({
    server: {
      AWS_REGION: z.string().min(1).default('us-east-1'),
      AWS_ENDPOINT_URL: z.url().optional(),
      AWS_ACCESS_KEY_ID: z.string().min(1),
      AWS_SECRET_ACCESS_KEY: z.string().min(1),
      SES_FROM_ADDRESS: z.email(),
      SES_SEND_RATE_LIMIT_PER_SECOND: z.coerce.number().int().positive().default(14)
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
