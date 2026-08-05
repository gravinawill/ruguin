import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { cacheENV } from '../packages/cache.environment.ts'
import { databaseENV } from '../packages/database.environment.ts'
import { messageBrokerENV } from '../packages/message-broker.environment.ts'
import { lazyEnvironment } from '../shared/lazy-environment.ts'
import { serverENV } from '../shared/server.environment.ts'

/*
 * ses-webhook-ingestor's single typed env entry point. SES_WEBHOOK_INGESTOR_SHARED_SECRET lives
 * directly under `server` (not a new packages/*.environment.ts file) because no other app needs
 * it — it authenticates the EventBridge API Destination invocation of this app's own endpoint.
 */
export const sesWebhookIngestorENV = lazyEnvironment(() =>
  createEnv({
    server: {
      SES_WEBHOOK_INGESTOR_SHARED_SECRET: z.string().min(1)
    },
    extends: [serverENV, cacheENV, messageBrokerENV, databaseENV],
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
