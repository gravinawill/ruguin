import { createEnv } from '@t3-oss/env-core'

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
    server: {},
    extends: [serverENV, databaseENV, cacheENV, messageBrokerENV, docsENV],
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
