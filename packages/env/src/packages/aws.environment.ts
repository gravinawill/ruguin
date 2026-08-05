import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { lazyEnvironment } from '../shared/lazy-environment.ts'

export const awsENV = lazyEnvironment(() =>
  createEnv({
    server: {
      AWS_REGION: z.string().min(1).default('us-east-1'),
      AWS_ENDPOINT_URL: z.url().optional(),
      /*
       * Optional on purpose: these are only meant for LocalStack (paired with AWS_ENDPOINT_URL).
       * A real AWS deployment must be able to rely on the SDK's default credential provider chain
       * (an ECS task role, an EKS service-account role, an instance profile) instead of carrying
       * long-lived static keys that can't rotate automatically — see any *-client.provider.ts,
       * which only passes `credentials` through when AWS_ENDPOINT_URL is set.
       */
      AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
      AWS_SECRET_ACCESS_KEY: z.string().min(1).optional()
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
