import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { awsENV } from '../packages/aws.environment.ts'
import { cacheENV } from '../packages/cache.environment.ts'
import { databaseENV } from '../packages/database.environment.ts'
import { docsENV } from '../packages/docs.environment.ts'
import { messageBrokerENV } from '../packages/message-broker.environment.ts'
import { lazyEnvironment } from '../shared/lazy-environment.ts'
import { serverENV } from '../shared/server.environment.ts'

/*
 * core-server's single typed env entry point: every package this app actually depends on,
 * composed via `extends` instead of scattering separate imports across its call sites. Add a new
 * `extends` entry here — never a new field under `server` — when the app starts using another
 * @ruguin/env package; `server` stays empty unless core-server needs a variable no existing
 * package already owns.
 */
export const coreServerENV = lazyEnvironment(() =>
  createEnv({
    server: {
      /*
       * How long a resolved (projectId, organizationId) tuple for a given API key stays cached.
       * Revoking a key has no effect until this expires — accepted explicitly by ticket EMAIL-3.
       */
      API_KEY_CACHE_TTL_IN_SECONDS: z.coerce.number().int().positive().default(300),
      SENDER_IDENTITY_CACHE_TTL_IN_SECONDS: z.coerce.number().int().positive().default(300),
      /*
       * How long a resolved Template stays cached in the send hot path. No active invalidation
       * exists yet (Template has no write path beyond seed) — this TTL is the only staleness
       * bound today; TemplateCacheProvider.invalidate() is ready for whenever a Template CRUD
       * endpoint calls it.
       */
      TEMPLATE_CACHE_TTL_IN_SECONDS: z.coerce.number().int().positive().default(300)
    },
    extends: [serverENV, databaseENV, cacheENV, messageBrokerENV, docsENV, awsENV],
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
