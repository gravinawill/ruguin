import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const loggerENV = createEnv({
  server: {
    LOGGER_DRIVER: z.enum(['pino', 'winston']).default('pino'),
    LOG_FORMAT: z.enum(['json', 'pretty']).default('pretty')
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true
})
