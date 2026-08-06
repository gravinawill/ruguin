import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { lazyEnvironment } from '../shared/lazy-environment.ts'

/*
 * Consumed only by core-server's e2e suites: `vitest.setup.e2e.ts` seeds these ids into
 * `process.env` once per e2e test file, before the file's own module code runs. `lazyEnvironment`
 * defers validation to first property access, so importing `@ruguin/env` anywhere else — including
 * production boot — never touches these vars or fails because they're unset.
 */
export const testSeedENV = lazyEnvironment(() =>
  createEnv({
    server: {
      TEST_SEEDED_ORGANIZATION_ID: z.string().min(1),
      TEST_SEEDED_PROJECT_ID: z.string().min(1),
      TEST_SEEDED_SENDER_IDENTITY_ID: z.string().min(1),
      TEST_SEEDED_SENDER_IDENTITY_EMAIL: z.string().min(1),
      TEST_SEEDED_TEMPLATE_ID: z.string().min(1),
      TEST_SEEDED_API_KEY: z.string().min(1)
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
