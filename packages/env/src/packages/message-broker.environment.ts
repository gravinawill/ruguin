import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { lazyEnvironment } from '../shared/lazy-environment.ts'

export const messageBrokerENV = lazyEnvironment(() =>
  createEnv({
    server: {
      KAFKA_BOOTSTRAP_BROKERS: z.string().min(1),
      KAFKA_CLIENT_ID: z.string().min(1).default('ruguin'),
      /*
       * Robust boolean parse: z.coerce.boolean() treats the string "false" as true,
       * which would silently enable auto-create — dangerous given the safe default.
       */
      KAFKA_SSL: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
      KAFKA_AUTO_CREATE_TOPICS: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
      KAFKA_TOPIC_PARTITIONS: z.coerce.number().int().positive().default(3),
      KAFKA_TOPIC_REPLICATION_FACTOR: z.coerce.number().int().positive().default(1)
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
