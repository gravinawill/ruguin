import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { lazyEnvironment } from '../shared/lazy-environment.ts'

/*
 * Split out of awsENV: these are specific to actually SENDING via SES (dispatch-worker), not to
 * managing AWS credentials in general. core-server also talks to SES now (sender identity
 * management, see apps/core-server.environment.ts), but never sends — extending this on top of
 * generic awsENV would force it to configure a from-address it never uses.
 */
export const sesENV = lazyEnvironment(() =>
  createEnv({
    server: {
      SES_FROM_ADDRESS: z.email(),
      SES_SEND_RATE_LIMIT_PER_SECOND: z.coerce.number().int().positive().default(14)
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
