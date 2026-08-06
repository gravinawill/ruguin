import { createEnv } from '@t3-oss/env-core'

import { awsENV } from '../packages/aws.environment.ts'
import { cacheENV } from '../packages/cache.environment.ts'
import { messageBrokerENV } from '../packages/message-broker.environment.ts'
import { sesENV } from '../packages/ses.environment.ts'
import { lazyEnvironment } from '../shared/lazy-environment.ts'
import { serverENV } from '../shared/server.environment.ts'

/*
 * dispatch-worker's single typed env entry point: every package this app actually depends on,
 * composed via `extends` instead of scattering separate imports across its call sites. Add a new
 * `extends` entry here — never a new field under `server` — when the app starts using another
 * @ruguin/env package; `server` stays empty unless dispatch-worker needs a variable no existing
 * package already owns.
 */
export const dispatchWorkerENV = lazyEnvironment(() =>
  createEnv({
    server: {},
    extends: [serverENV, cacheENV, messageBrokerENV, awsENV, sesENV],
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
