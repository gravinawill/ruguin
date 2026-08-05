# SES Webhook Ingestor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/ses-webhook-ingestor`, a new NestJS/Fastify service that receives SES delivery/bounce/complaint notifications via an EventBridge API Destination, correlates them back to internal `emailId`s, and republishes `email.status.updated` on Kafka.

**Architecture:** Mirrors `apps/dispatch-worker`'s skeleton (NestJS + Fastify, Pino, `@ruguin/cache`, `@ruguin/message-broker`) plus a Prisma-backed Postgres schema (mirroring `apps/core-server`'s pattern) holding a `sesMessageId → emailId` correlation table. A Kafka consumer on `email.status.updated` (filtered to `status=sent`) populates that table; the HTTP endpoint looks it up on each incoming notification and republishes, or defers to an internal retry topic when the lookup race hasn't resolved yet.

**Tech Stack:** NestJS 11, Fastify, Prisma 7 (`@prisma/adapter-pg`), Zod 4, `@platformatic/kafka` (via `@ruguin/message-broker`), Redis/Valkey (via `@ruguin/cache`), Vitest.

## Global Constraints

- Node.js 20+ (repo pins `engines.node: 26.5.0`), TypeScript strict mode, ESM only (no CommonJS), imports without extensions in `src/` (rewritten post-build by `scripts/fix-esm-imports.mjs`).
- `Either`/`Success`/`Failure` from `@ruguin/utils` for expected/domain failures — never throw for expected failures, never invent ad-hoc result types.
- Every Kafka consumer must be safe under at-least-once redelivery (idempotent handlers, dedup where the design calls for it) and must route malformed messages to a DLQ rather than blocking the partition.
- Files under 500 lines; comment only what the code cannot say — the *why*, not the *what*.
- No `Co-Authored-By` trailer on commits.
- Design reference: `docs/superpowers/specs/2026-08-04-ses-webhook-ingestor-design.md` — read it before starting; every task below implements one piece of it.

---

## Task 1: Event contract — `bounceType` on `EmailStatusUpdatedPayloadSchema`

**Files:**
- Modify: `packages/event-schemas/src/email-status-updated.schema.ts`
- Modify: `packages/event-schemas/src/__tests__/email-status-updated.schema.unit.ts`

**Interfaces:**
- Produces: `SesBounceType` (`{ PERMANENT: 'Permanent', TRANSIENT: 'Transient', UNDETERMINED: 'Undetermined' }`), exported from `@ruguin/event-schemas`. `EmailStatusUpdatedPayloadSchema` gains an optional `bounceType: z.enum(SesBounceType)` field. Both are consumed by Task 2's schema and by the ingestor's domain mapping (Task 6).

- [ ] **Step 1: Write the failing test**

Add to `packages/event-schemas/src/__tests__/email-status-updated.schema.unit.ts` (append inside the existing `describe` block, right after the "accepts a failed status" test):

```ts
  it('accepts a "bounced" status with a bounceType', () => {
    const result = EmailStatusUpdatedPayloadSchema.safeParse({
      emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
      status: 'bounced',
      bounceType: 'Permanent'
    })

    expect(result.success).toBe(true)
  })

  it('rejects a bounceType outside Permanent/Transient/Undetermined', () => {
    const result = EmailStatusUpdatedPayloadSchema.safeParse({
      emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
      status: 'bounced',
      bounceType: 'Nonsense'
    })

    expect(result.success).toBe(false)
  })

  it('exposes SesBounceType', () => {
    expect(SesBounceType).toEqual({ PERMANENT: 'Permanent', TRANSIENT: 'Transient', UNDETERMINED: 'Undetermined' })
  })
```

Update the top import to also bring in `SesBounceType`:

```ts
import { EMAIL_STATUS_UPDATED_DLQ_TOPIC, EMAIL_STATUS_UPDATED_TOPIC, EmailStatusUpdatedPayloadSchema, SesBounceType } from '../email-status-updated.schema.ts'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/event-schemas test:unit`
Expected: FAIL — `SesBounceType` is not exported, and `bounceType` is rejected as an unrecognized key (or the "rejects" test passes vacuously while the "accepts" one fails — either way, red).

- [ ] **Step 3: Write minimal implementation**

`packages/event-schemas/src/email-status-updated.schema.ts` — full new contents:

```ts
import { z } from 'zod'

export const EMAIL_STATUS_UPDATED_TOPIC = 'email.status.updated'
export const EMAIL_STATUS_UPDATED_DLQ_TOPIC = 'email.status.updated.dlq'

export const EmailStatusUpdatedStatus = {
  SENT: 'sent',
  DELIVERED: 'delivered',
  BOUNCED: 'bounced',
  COMPLAINED: 'complained',
  FAILED: 'failed'
} as const

export const SesBounceType = {
  PERMANENT: 'Permanent',
  TRANSIENT: 'Transient',
  UNDETERMINED: 'Undetermined'
} as const

export const EmailStatusUpdatedPayloadSchema = z.object({
  emailId: z.uuid(),
  status: z.enum(EmailStatusUpdatedStatus),
  sesMessageId: z.string().min(1).optional(),
  errorMessage: z.string().min(1).optional(),
  /* Only ever set alongside status=bounced; SES's own bounce classification (see EMAIL_STATUS_UPDATED_TOPIC's
   * producers: dispatch-worker never sets it, ses-webhook-ingestor sets it when eventType=Bounce). */
  bounceType: z.enum(SesBounceType).optional()
})

export type EmailStatusUpdatedPayload = z.infer<typeof EmailStatusUpdatedPayloadSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/event-schemas test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/event-schemas/src/email-status-updated.schema.ts packages/event-schemas/src/__tests__/email-status-updated.schema.unit.ts
git commit -m "feat(event-schemas): add bounceType to EmailStatusUpdatedPayloadSchema"
```

---

## Task 2: Event contract — SES notification correlation retry/DLQ topics + payload schema

**Files:**
- Create: `packages/event-schemas/src/ses-notification-correlation.schema.ts`
- Create: `packages/event-schemas/src/__tests__/ses-notification-correlation.schema.unit.ts`
- Modify: `packages/event-schemas/src/index.ts`

**Interfaces:**
- Consumes: `EmailStatusUpdatedStatus`, `SesBounceType` from Task 1.
- Produces: `SES_NOTIFICATION_CORRELATION_RETRY_TOPIC` (`'ses.notification.correlation.retry'`), `SES_NOTIFICATION_CORRELATION_DLQ_TOPIC` (`'ses.notification.correlation.dlq'`), `SES_NOTIFICATION_MALFORMED_DLQ_TOPIC` (`'ses.notification.malformed.dlq'`), `SesNotificationCorrelationStatus` (subset `{DELIVERED, BOUNCED, COMPLAINED}`), `SesNotificationCorrelationPendingPayloadSchema` (fields: `sesMessageId: string`, `status: enum`, `bounceType?: enum`) and its inferred type `SesNotificationCorrelationPendingPayload`. All consumed by the ingestor app starting at Task 9.

- [ ] **Step 1: Write the failing test**

`packages/event-schemas/src/__tests__/ses-notification-correlation.schema.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  SES_NOTIFICATION_CORRELATION_DLQ_TOPIC,
  SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
  SES_NOTIFICATION_MALFORMED_DLQ_TOPIC,
  SesNotificationCorrelationPendingPayloadSchema
} from '../ses-notification-correlation.schema.ts'

describe('SesNotificationCorrelationPendingPayloadSchema', () => {
  it('accepts a delivered notification with no bounceType', () => {
    const result = SesNotificationCorrelationPendingPayloadSchema.safeParse({
      sesMessageId: 'ses-msg-1',
      status: 'delivered'
    })

    expect(result.success).toBe(true)
  })

  it('accepts a bounced notification with bounceType', () => {
    const result = SesNotificationCorrelationPendingPayloadSchema.safeParse({
      sesMessageId: 'ses-msg-1',
      status: 'bounced',
      bounceType: 'Transient'
    })

    expect(result.success).toBe(true)
  })

  it('rejects a status outside delivered/bounced/complained', () => {
    const result = SesNotificationCorrelationPendingPayloadSchema.safeParse({
      sesMessageId: 'ses-msg-1',
      status: 'sent'
    })

    expect(result.success).toBe(false)
  })

  it('rejects an empty sesMessageId', () => {
    const result = SesNotificationCorrelationPendingPayloadSchema.safeParse({
      sesMessageId: '',
      status: 'delivered'
    })

    expect(result.success).toBe(false)
  })

  it('exposes the retry, correlation DLQ, and malformed DLQ topic constants', () => {
    expect(SES_NOTIFICATION_CORRELATION_RETRY_TOPIC).toBe('ses.notification.correlation.retry')
    expect(SES_NOTIFICATION_CORRELATION_DLQ_TOPIC).toBe('ses.notification.correlation.dlq')
    expect(SES_NOTIFICATION_MALFORMED_DLQ_TOPIC).toBe('ses.notification.malformed.dlq')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/event-schemas test:unit`
Expected: FAIL — module `../ses-notification-correlation.schema.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

`packages/event-schemas/src/ses-notification-correlation.schema.ts`:

```ts
import { z } from 'zod'

import { EmailStatusUpdatedStatus, SesBounceType } from './email-status-updated.schema.ts'

export const SES_NOTIFICATION_CORRELATION_RETRY_TOPIC = 'ses.notification.correlation.retry'
export const SES_NOTIFICATION_CORRELATION_DLQ_TOPIC = 'ses.notification.correlation.dlq'
export const SES_NOTIFICATION_MALFORMED_DLQ_TOPIC = 'ses.notification.malformed.dlq'

/* Only the three statuses ses-webhook-ingestor can ever produce — sent/failed never flow through
 * this retry loop, so admitting them here would let a producer bug schedule a nonsensical retry. */
export const SesNotificationCorrelationStatus = {
  DELIVERED: EmailStatusUpdatedStatus.DELIVERED,
  BOUNCED: EmailStatusUpdatedStatus.BOUNCED,
  COMPLAINED: EmailStatusUpdatedStatus.COMPLAINED
} as const

export const SesNotificationCorrelationPendingPayloadSchema = z.object({
  sesMessageId: z.string().min(1),
  status: z.enum(SesNotificationCorrelationStatus),
  bounceType: z.enum(SesBounceType).optional()
})

export type SesNotificationCorrelationPendingPayload = z.infer<typeof SesNotificationCorrelationPendingPayloadSchema>
```

Update `packages/event-schemas/src/index.ts`:

```ts
export * from './email-engagement.schema.ts'
export * from './email-send-requested.schema.ts'
export * from './email-status-updated.schema.ts'
export * from './message-envelope.schema.ts'
export * from './ses-notification-correlation.schema.ts'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/event-schemas test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/event-schemas/src/ses-notification-correlation.schema.ts packages/event-schemas/src/__tests__/ses-notification-correlation.schema.unit.ts packages/event-schemas/src/index.ts
git commit -m "feat(event-schemas): add SES notification correlation retry/DLQ topics"
```

---

## Task 3: New app walking skeleton (scaffold + cache-only health check)

**Files:**
- Create: `apps/ses-webhook-ingestor/package.json`
- Create: `apps/ses-webhook-ingestor/tsconfig.json`
- Create: `apps/ses-webhook-ingestor/tsconfig.build.json`
- Create: `apps/ses-webhook-ingestor/nest-cli.json`
- Create: `apps/ses-webhook-ingestor/.swcrc`
- Create: `apps/ses-webhook-ingestor/eslint.config.ts`
- Create: `apps/ses-webhook-ingestor/vitest.config.ts`
- Create: `apps/ses-webhook-ingestor/vitest.setup.e2e.ts`
- Create: `apps/ses-webhook-ingestor/src/main.ts`
- Create: `apps/ses-webhook-ingestor/src/app.module.ts`
- Create: `apps/ses-webhook-ingestor/src/shared/infrastructure/logger/pino-http-options.ts`
- Create: `apps/ses-webhook-ingestor/src/health/health.module.ts`
- Create: `apps/ses-webhook-ingestor/src/health/health.controller.ts`
- Test: `apps/ses-webhook-ingestor/src/health/__tests__/health.controller.e2e.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (this is the foundation).
- Produces: `AppModule` (importable by every later task's tests via `Test.createTestingModule({ imports: [AppModule] })`), a working `GET /health` returning `200` with `{ status: 'ok', info: { cache: { status: 'up' } } }` once cache is up. `HealthModule`/`HealthController` will be extended in Task 5 to add a database check.

- [ ] **Step 1: Create the package manifest**

`apps/ses-webhook-ingestor/package.json`:

```json
{
  "name": "@ruguin/ses-webhook-ingestor",
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "build": "prisma generate && nest build && node ../core-server/scripts/fix-esm-imports.mjs",
    "check:lint": "eslint . --max-warnings 0",
    "check:types": "tsc --noEmit --pretty",
    "clean": "rm -rf .claude-flow .swarm .superpowers .remember .gitnexus .turbo coverage node_modules dist build src/shared/infrastructure/database/prisma/generated",
    "db:deploy": "prisma migrate deploy",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:studio": "prisma studio",
    "dev": "nodemon --watch src --ext ts --ignore \"src/**/generated/**\" --exec \"pnpm run build && pnpm run start\"",
    "fix:lint": "eslint --fix .",
    "start": "node dist/main.js",
    "start:dev": "nodemon --watch src --ext ts --ignore \"src/**/generated/**\" --exec \"pnpm run build && pnpm run start\"",
    "test": "vitest run --project unit",
    "test:all": "vitest run",
    "test:e2e": "vitest run --project e2e",
    "test:integration": "vitest run --project integration",
    "update:deps": "ncu -u"
  },
  "dependencies": {
    "@nestjs/common": "^11.1.28",
    "@nestjs/core": "^11.1.28",
    "@nestjs/platform-fastify": "^11.1.28",
    "@nestjs/terminus": "^11.1.1",
    "@prisma/adapter-pg": "^7.9.1",
    "@prisma/client": "^7.9.1",
    "@ruguin/cache": "workspace:*",
    "@ruguin/env": "workspace:*",
    "@ruguin/event-schemas": "workspace:*",
    "@ruguin/message-broker": "workspace:*",
    "@ruguin/shared-domain": "workspace:*",
    "@ruguin/utils": "workspace:*",
    "nestjs-pino": "^4.6.1",
    "pino-http": "^11.0.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.24",
    "@nestjs/schematics": "^11.1.0",
    "@nestjs/testing": "^11.1.28",
    "@ruguin/eslint-config": "workspace:*",
    "@ruguin/prettier-config": "workspace:*",
    "@ruguin/typescript-config": "workspace:*",
    "@swc/cli": "^0.8.1",
    "@swc/core": "^1.15.47",
    "@types/node": "^26.1.2",
    "@vitest/coverage-v8": "^4.1.10",
    "nodemon": "^3.1.14",
    "pino-pretty": "^13.1.3",
    "prisma": "^7.9.1",
    "typescript": "6.0.3",
    "unplugin-swc": "^1.5.9",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 2: Create the build/lint/test config files**

`apps/ses-webhook-ingestor/tsconfig.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ruguin/typescript-config/nestjs.json",
  "compilerOptions": {
    "outDir": "./dist"
  }
}
```

`apps/ses-webhook-ingestor/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true
  },
  "exclude": [
    "node_modules",
    "test",
    "dist",
    "**/*spec.ts",
    "**/*.unit.ts",
    "**/*.e2e.ts",
    "**/*.int.ts",
    "eslint.config.ts",
    "vitest.config.ts"
  ]
}
```

`apps/ses-webhook-ingestor/nest-cli.json`:

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "builder": {
      "type": "swc",
      "options": {
        "ignore": ["**/*.spec.ts", "**/*.unit.ts", "**/*.e2e.ts", "**/*.int.ts"]
      }
    },
    "typeCheck": true
  }
}
```

`apps/ses-webhook-ingestor/.swcrc`:

```json
{
  "$schema": "https://json.schemastore.org/swcrc",
  "sourceMaps": true,
  "module": {
    "type": "es6"
  },
  "jsc": {
    "parser": {
      "syntax": "typescript",
      "decorators": true
    },
    "transform": {
      "legacyDecorator": true,
      "decoratorMetadata": true
    },
    "target": "es2022",
    "keepClassNames": true
  }
}
```

`apps/ses-webhook-ingestor/eslint.config.ts`:

```ts
import { defineConfig } from '@ruguin/eslint-config'

/*
 * NestJS modules are decorator-only classes with no members by design (see the same override in
 * apps/dispatch-worker/eslint.config.ts and apps/core-server/eslint.config.ts).
 */
export default defineConfig(
  {},
  {
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off'
    }
  }
)
```

`apps/ses-webhook-ingestor/vitest.config.ts`:

```ts
import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

const swcPlugin = swc.vite({
  module: { type: 'es6' },
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: 'es2022',
    keepClassNames: true
  }
})

export default defineConfig({
  oxc: false,
  plugins: [swcPlugin],
  test: {
    globals: true,
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    reporters: ['verbose'],
    passWithNoTests: true,
    /*
     * Same reasoning as apps/dispatch-worker/vitest.config.ts: integration/e2e files each boot
     * their own AppModule against the same real Kafka broker with hardcoded consumer group IDs —
     * two module instances racing in the same group would split partitions and cause cross-file
     * misses. Serializing files avoids that; unit tests dominate the file count so the cost is low.
     */
    fileParallelism: false,
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/__tests__/**/*.unit.ts'], testTimeout: 5000 } },
      { extends: true, test: { name: 'integration', include: ['src/**/__tests__/**/*.int.ts'], testTimeout: 20_000 } },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['src/**/__tests__/**/*.e2e.ts'],
          setupFiles: ['./vitest.setup.e2e.ts'],
          testTimeout: 30_000
        }
      }
    ]
  }
})
```

`apps/ses-webhook-ingestor/vitest.setup.e2e.ts`:

```ts
import 'reflect-metadata'
```

- [ ] **Step 3: Install dependencies so workspace links and CLIs resolve**

Run: `pnpm install`
Expected: lockfile updates, `node_modules/.bin/nest` and `node_modules/.bin/prisma` become resolvable from `apps/ses-webhook-ingestor`.

- [ ] **Step 4: Write the logger options and main entrypoint**

`apps/ses-webhook-ingestor/src/shared/infrastructure/logger/pino-http-options.ts` (identical to `apps/dispatch-worker`'s):

```ts
import { serverENV } from '@ruguin/env'
import { type Options } from 'pino-http'

export function createPinoHttpOptions(): Options {
  const isProduction = serverENV.ENVIRONMENT === 'production'

  return {
    level: isProduction ? 'info' : 'debug',
    ...(!isProduction && { transport: { target: 'pino-pretty' } }),
    redact: ['req.headers.authorization', 'req.headers.cookie']
  }
}
```

`apps/ses-webhook-ingestor/src/main.ts`:

```ts
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Logger } from 'nestjs-pino'

import { AppModule } from './app.module.ts'

/*
 * Not read from @ruguin/env's serverENV.PORT — this repo loads one shared root .env for every
 * app (see apps/dispatch-worker/src/main.ts's identical comment), so a runtime-configurable PORT
 * would collide with core-server/dispatch-worker whenever more than one runs locally at once.
 * dispatch-worker took 3334; this is the next free slot.
 */
const PORT = 3335

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
  bufferLogs: true
})
app.useLogger(app.get(Logger))
app.enableShutdownHooks()
await app.listen(PORT, '0.0.0.0')
```

- [ ] **Step 5: Write the health module (cache only for now) and its e2e test**

`apps/ses-webhook-ingestor/src/health/health.controller.ts`:

```ts
import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common'
import { HealthCheck, type HealthCheckResult, HealthCheckService } from '@nestjs/terminus'
import { CacheHealthIndicator } from '@ruguin/cache'

@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly cacheHealth: CacheHealthIndicator
  ) {}

  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([() => this.cacheHealth.isHealthy('cache')])
  }
}
```

`apps/ses-webhook-ingestor/src/health/health.module.ts`:

```ts
import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { CacheHealthIndicator } from '@ruguin/cache'

import { HealthController } from './health.controller.ts'

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [CacheHealthIndicator]
})
export class HealthModule {}
```

`apps/ses-webhook-ingestor/src/app.module.ts` (cache-only for now; Kafka/DB/domain module join in later tasks):

```ts
import { Module } from '@nestjs/common'
import { CacheModule } from '@ruguin/cache'
import { cacheENV } from '@ruguin/env'
import { LoggerModule } from 'nestjs-pino'

import { HealthModule } from './health/health.module.ts'
import { createPinoHttpOptions } from './shared/infrastructure/logger/pino-http-options.ts'

@Module({
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => ({
        pinoHttp: createPinoHttpOptions()
      })
    }),

    CacheModule.forRoot({
      isGlobal: true,
      driver: cacheENV.CACHE_DRIVER,
      jitterRatio: cacheENV.CACHE_JITTER_RATIO,
      defaultTtlInMs: cacheENV.CACHE_DEFAULT_TTL_MS,
      defaultConsistency: cacheENV.CACHE_DEFAULT_CONSISTENCY,
      invalidationBroadcast: cacheENV.CACHE_INVALIDATION_BROADCAST,
      prefix: cacheENV.CACHE_PREFIX,
      negativeTtlInMs: cacheENV.CACHE_NEGATIVE_TTL_MS,
      lockTtlInMs: cacheENV.CACHE_OPERATION_TIMEOUT_MS * 10,
      operationTimeoutInMs: cacheENV.CACHE_OPERATION_TIMEOUT_MS,
      namespaceVersionLocalTtlInMs: cacheENV.CACHE_NS_VERSION_LOCAL_TTL_MS,
      replicationLagThresholdInBytes: cacheENV.CACHE_REPLICATION_LAG_THRESHOLD_BYTES,
      breaker: {
        failureThreshold: cacheENV.CACHE_BREAKER_FAILURE_THRESHOLD,
        resetTimeoutInMs: cacheENV.CACHE_BREAKER_RESET_TIMEOUT_MS
      },
      ...(cacheENV.CACHE_MASTER_URL !== undefined && { masterUrl: cacheENV.CACHE_MASTER_URL }),
      ...(cacheENV.CACHE_REPLICA_URLS.length > 0 && { replicaUrls: cacheENV.CACHE_REPLICA_URLS })
    }),

    HealthModule
  ],
  controllers: [],
  providers: []
})
export class AppModule {}
```

`apps/ses-webhook-ingestor/src/health/__tests__/health.controller.e2e.ts` (identical pattern to dispatch-worker's):

```ts
import { type INestApplication } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../app.module.ts'

vi.hoisted(() => {
  process.env.CACHE_PREFIX = 'ruguin:e2e'
  process.env.CACHE_DRIVER = 'memory'
})

describe('GET /health', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()

    app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.init()
    await (app as unknown as NestFastifyApplication).getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 200 with cache reported as up', async () => {
    const response = await (app as unknown as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toMatchObject({ status: 'ok', info: { cache: { status: 'up' } } })
  })
})
```

- [ ] **Step 6: Run the e2e test to verify it fails, then passes**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test:e2e`
Expected first: FAIL (module doesn't build yet / files just created — run once to confirm the test file itself is wired correctly, i.e. it actually executes and fails for the right reason if anything is misconfigured).

Then run: `pnpm --filter @ruguin/ses-webhook-ingestor build && pnpm --filter @ruguin/ses-webhook-ingestor test:e2e`
Expected: PASS (requires `docker compose -f infrastructure/local/docker-compose.yml up -d redis` running, or `CACHE_DRIVER=memory` as stubbed above — the stub makes this test self-contained without real Redis).

- [ ] **Step 7: Run build and lint to confirm the skeleton is sound**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor build && pnpm --filter @ruguin/ses-webhook-ingestor check:types && pnpm --filter @ruguin/ses-webhook-ingestor check:lint`
Expected: all three succeed with no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/ses-webhook-ingestor pnpm-lock.yaml
git commit -m "feat(ses-webhook-ingestor): scaffold app skeleton with cache-only health check"
```

---

## Task 4: Env — `sesWebhookIngestorENV`

**Files:**
- Create: `packages/env/src/apps/ses-webhook-ingestor.environment.ts`
- Create: `packages/env/src/apps/__tests__/ses-webhook-ingestor.environment.unit.ts`
- Modify: `packages/env/src/apps/index.ts`

**Interfaces:**
- Produces: `sesWebhookIngestorENV` — composed env object (extends `serverENV`, `cacheENV`, `messageBrokerENV`, `databaseENV`), plus its own `SES_WEBHOOK_INGESTOR_SHARED_SECRET: string`. Consumed by the auth guard (Task 13) and by `app.module.ts` (Task 4/5) for `DATABASE_URL`.

- [ ] **Step 1: Write the failing test**

`packages/env/src/apps/__tests__/ses-webhook-ingestor.environment.unit.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

const setEnvironment = (environment: Record<string, string>): void => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
}

const MINIMUM_REQUIRED_ENVIRONMENT = {
  ENVIRONMENT: 'test',
  CACHE_PREFIX: 'ruguin:ses-webhook-ingestor',
  KAFKA_BOOTSTRAP_BROKERS: 'localhost:9092',
  DATABASE_URL: 'postgresql://ruguin:ruguin@localhost:5432/ruguin',
  SES_WEBHOOK_INGESTOR_SHARED_SECRET: 'a-shared-secret'
}

describe('sesWebhookIngestorENV', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('exposes every field from each extended package plus its own', async () => {
    setEnvironment(MINIMUM_REQUIRED_ENVIRONMENT)

    const { sesWebhookIngestorENV } = await import('../ses-webhook-ingestor.environment.ts')

    // serverENV
    expect(sesWebhookIngestorENV.ENVIRONMENT).toBe('test')
    // cacheENV
    expect(sesWebhookIngestorENV.CACHE_PREFIX).toBe('ruguin:ses-webhook-ingestor')
    // messageBrokerENV
    expect(sesWebhookIngestorENV.KAFKA_BOOTSTRAP_BROKERS).toBe('localhost:9092')
    // databaseENV
    expect(sesWebhookIngestorENV.DATABASE_URL).toBe('postgresql://ruguin:ruguin@localhost:5432/ruguin')
    // its own field
    expect(sesWebhookIngestorENV.SES_WEBHOOK_INGESTOR_SHARED_SECRET).toBe('a-shared-secret')
  })

  it('throws when SES_WEBHOOK_INGESTOR_SHARED_SECRET is missing', async () => {
    setEnvironment({ ...MINIMUM_REQUIRED_ENVIRONMENT, SES_WEBHOOK_INGESTOR_SHARED_SECRET: '' })

    const { sesWebhookIngestorENV } = await import('../ses-webhook-ingestor.environment.ts')

    expect(() => ({ ...sesWebhookIngestorENV })).toThrow()
  })

  it('throws when a required field from an extended package is missing', async () => {
    setEnvironment({ ...MINIMUM_REQUIRED_ENVIRONMENT, DATABASE_URL: '' })

    const { sesWebhookIngestorENV } = await import('../ses-webhook-ingestor.environment.ts')

    expect(() => ({ ...sesWebhookIngestorENV })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/env test:unit`
Expected: FAIL — module `../ses-webhook-ingestor.environment.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

`packages/env/src/apps/ses-webhook-ingestor.environment.ts`:

```ts
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
```

Update `packages/env/src/apps/index.ts`:

```ts
export * from './core-server.environment.ts'
export * from './dispatch-worker.environment.ts'
export * from './ses-webhook-ingestor.environment.ts'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/env test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/env/src/apps/ses-webhook-ingestor.environment.ts packages/env/src/apps/__tests__/ses-webhook-ingestor.environment.unit.ts packages/env/src/apps/index.ts
git commit -m "feat(env): add sesWebhookIngestorENV"
```

---

## Task 5: Postgres schema, Prisma service, DB health — wired into `app.module.ts`

**Files:**
- Create: `apps/ses-webhook-ingestor/prisma.config.ts`
- Create: `apps/ses-webhook-ingestor/prisma/schema/schema.prisma`
- Create: `apps/ses-webhook-ingestor/prisma/schema/correlation.prisma`
- Create: `apps/ses-webhook-ingestor/src/shared/infrastructure/database/prisma/prisma.service.ts`
- Create: `apps/ses-webhook-ingestor/src/shared/infrastructure/database/database.module.ts`
- Create: `apps/ses-webhook-ingestor/src/shared/infrastructure/database/prisma/database-health.indicator.ts`
- Modify: `apps/ses-webhook-ingestor/src/app.module.ts`
- Modify: `apps/ses-webhook-ingestor/src/health/health.module.ts`
- Modify: `apps/ses-webhook-ingestor/src/health/health.controller.ts`
- Modify: `apps/ses-webhook-ingestor/src/health/__tests__/health.controller.e2e.ts`
- Create: `apps/ses-webhook-ingestor/src/health/__tests__/health.controller.database-down.e2e.ts`

**Interfaces:**
- Consumes: `sesWebhookIngestorENV`/`databaseENV` (Task 4) for `DATABASE_URL`.
- Produces: `PrismaService` (extends the generated `PrismaClient`, exported by `DatabaseModule`, global), `DatabaseModule.forRoot({ connectionString })`, `DATABASE_SCHEMA = 'ses_webhook_ingestor'` constant, `withSchema(connectionString): string` helper in `app.module.ts`. The generated Prisma model `SesMessageCorrelation { sesMessageId: String @id, emailId: String, createdAt: DateTime }` — consumed by the correlation repository in Task 7.

- [ ] **Step 1: Add the Prisma config and schema**

`apps/ses-webhook-ingestor/prisma.config.ts` (identical pattern to `apps/core-server`'s):

```ts
import { defineConfig } from 'prisma/config'

const databaseUrl = process.env.DATABASE_URL
const datasource = databaseUrl === undefined || databaseUrl === '' ? {} : { url: databaseUrl }

export default defineConfig({
  datasource,
  migrations: {
    path: './prisma/migrations'
  },
  schema: './prisma/schema'
})
```

`apps/ses-webhook-ingestor/prisma/schema/schema.prisma`:

```prisma
generator client {
  provider            = "prisma-client"
  output              = "../../src/shared/infrastructure/database/prisma/generated"
  importFileExtension = "js"
}

datasource db {
  provider = "postgresql"
}
```

`apps/ses-webhook-ingestor/prisma/schema/correlation.prisma`:

```prisma
// sesMessageId is the AWS-assigned SES message id (dispatch-worker's SendEmailCommand response),
// the only identifier the EventBridge notification carries back — see the design doc's
// "Decisão de arquitetura: correlação sesMessageId → emailId".
model SesMessageCorrelation {
  sesMessageId String   @id
  emailId      String
  createdAt    DateTime @default(now())

  @@map("ses_message_correlations")
}
```

- [ ] **Step 2: Generate the Prisma client and run the initial migration**

Run: `docker compose -f infrastructure/local/docker-compose.yml up -d postgres` (if not already running)
Run: `pnpm --filter @ruguin/ses-webhook-ingestor db:migrate -- --name init_correlation_table`
Expected: creates `apps/ses-webhook-ingestor/prisma/migrations/<timestamp>_init_correlation_table/migration.sql` (a `CREATE TABLE ses_message_correlations (...)` statement) and generates the Prisma client at `src/shared/infrastructure/database/prisma/generated/`.

- [ ] **Step 3: Write the PrismaService, DatabaseModule, and DB health indicator**

`apps/ses-webhook-ingestor/src/shared/infrastructure/database/prisma/prisma.service.ts` (identical to `apps/core-server`'s):

```ts
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from './generated/client'

export const DATABASE_CONNECTION_STRING = Symbol('DATABASE_CONNECTION_STRING')

export function resolveSchemaFrom(connectionString: string): Record<string, never> | { schema: string } {
  const schema = new URL(connectionString).searchParams.get('schema')

  return schema === null || schema === '' ? {} : { schema }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  public readonly schema: string

  constructor(@Inject(DATABASE_CONNECTION_STRING) connectionString: string) {
    const resolvedSchema = resolveSchemaFrom(connectionString)
    super({ adapter: new PrismaPg({ connectionString }, resolvedSchema) })
    this.schema = 'schema' in resolvedSchema ? resolvedSchema.schema : 'public'
  }

  public async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
  }
}
```

`apps/ses-webhook-ingestor/src/shared/infrastructure/database/database.module.ts` — lighter than core-server's: no `TRANSACTION_MANAGER`, since this app never needs a cross-write transaction (correlation upsert/lookup are single statements):

```ts
import { type DynamicModule, Module } from '@nestjs/common'

import { DATABASE_CONNECTION_STRING, PrismaService } from './prisma/prisma.service.ts'

@Module({})
export class DatabaseModule {
  public static forRoot(options: { connectionString: string }): DynamicModule {
    return {
      module: this,
      global: true,
      providers: [{ provide: DATABASE_CONNECTION_STRING, useValue: options.connectionString }, PrismaService],
      exports: [PrismaService]
    }
  }
}
```

`apps/ses-webhook-ingestor/src/shared/infrastructure/database/prisma/database-health.indicator.ts` (identical to `apps/core-server`'s):

```ts
import { Injectable } from '@nestjs/common'
import { type HealthIndicatorResult } from '@nestjs/terminus'

import { PrismaService } from './prisma.service.ts'

const MAX_ERROR_LENGTH = 200
const UNKNOWN_FAILURE = 'Unknown failure while querying the database.'

function toSingleLine(error: unknown): string {
  if (!(error instanceof Error)) return UNKNOWN_FAILURE

  const collapsed = error.message.replaceAll(/\s+/gu, ' ').trim()

  if (collapsed === '') return UNKNOWN_FAILURE

  return collapsed.length > MAX_ERROR_LENGTH ? `${collapsed.slice(0, MAX_ERROR_LENGTH)}…` : collapsed
}

@Injectable()
export class DatabaseHealthIndicator {
  constructor(private readonly prisma: PrismaService) {}

  public async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const startedAt = performance.now()

    try {
      await this.prisma.$queryRaw`SELECT 1`

      return { [key]: { latencyInMs: Math.round(performance.now() - startedAt), status: 'up' } }
    } catch (error: unknown) {
      return { [key]: { error: toSingleLine(error), status: 'down' } }
    }
  }
}
```

- [ ] **Step 4: Wire DatabaseModule into `app.module.ts` and extend the health check**

`apps/ses-webhook-ingestor/src/health/health.controller.ts` (full replacement):

```ts
import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common'
import { HealthCheck, type HealthCheckResult, HealthCheckService } from '@nestjs/terminus'
import { CacheHealthIndicator } from '@ruguin/cache'

import { DatabaseHealthIndicator } from '../shared/infrastructure/database/prisma/database-health.indicator.ts'

@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly cacheHealth: CacheHealthIndicator,
    private readonly databaseHealth: DatabaseHealthIndicator
  ) {}

  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.cacheHealth.isHealthy('cache'),
      () => this.databaseHealth.isHealthy('database')
    ])
  }
}
```

`apps/ses-webhook-ingestor/src/health/health.module.ts` (full replacement):

```ts
import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { CacheHealthIndicator } from '@ruguin/cache'

import { DatabaseHealthIndicator } from '../shared/infrastructure/database/prisma/database-health.indicator.ts'

import { HealthController } from './health.controller.ts'

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [CacheHealthIndicator, DatabaseHealthIndicator]
})
export class HealthModule {}
```

`apps/ses-webhook-ingestor/src/app.module.ts` (full replacement — adds `DatabaseModule`):

```ts
import { Module } from '@nestjs/common'
import { CacheModule } from '@ruguin/cache'
import { cacheENV, databaseENV } from '@ruguin/env'
import { LoggerModule } from 'nestjs-pino'

import { HealthModule } from './health/health.module.ts'
import { DatabaseModule } from './shared/infrastructure/database/database.module.ts'
import { createPinoHttpOptions } from './shared/infrastructure/logger/pino-http-options.ts'

/*
 * Same Postgres instance/database as every other app (docs/superpowers/specs/2026-08-04-ses-webhook-ingestor-design.md
 * "Cada serviço possui seu próprio schema Postgres dentro da mesma instância") — isolation comes
 * from a distinct schema, not a distinct DATABASE_URL, since the whole monorepo shares one root
 * .env. PrismaService reads the schema back out of the connection string's `schema` query param
 * (see prisma.service.ts's resolveSchemaFrom).
 */
const DATABASE_SCHEMA = 'ses_webhook_ingestor'

export function withSchema(connectionString: string): string {
  const separator = connectionString.includes('?') ? '&' : '?'
  return `${connectionString}${separator}schema=${DATABASE_SCHEMA}`
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => ({
        pinoHttp: createPinoHttpOptions()
      })
    }),

    CacheModule.forRoot({
      isGlobal: true,
      driver: cacheENV.CACHE_DRIVER,
      jitterRatio: cacheENV.CACHE_JITTER_RATIO,
      defaultTtlInMs: cacheENV.CACHE_DEFAULT_TTL_MS,
      defaultConsistency: cacheENV.CACHE_DEFAULT_CONSISTENCY,
      invalidationBroadcast: cacheENV.CACHE_INVALIDATION_BROADCAST,
      prefix: cacheENV.CACHE_PREFIX,
      negativeTtlInMs: cacheENV.CACHE_NEGATIVE_TTL_MS,
      lockTtlInMs: cacheENV.CACHE_OPERATION_TIMEOUT_MS * 10,
      operationTimeoutInMs: cacheENV.CACHE_OPERATION_TIMEOUT_MS,
      namespaceVersionLocalTtlInMs: cacheENV.CACHE_NS_VERSION_LOCAL_TTL_MS,
      replicationLagThresholdInBytes: cacheENV.CACHE_REPLICATION_LAG_THRESHOLD_BYTES,
      breaker: {
        failureThreshold: cacheENV.CACHE_BREAKER_FAILURE_THRESHOLD,
        resetTimeoutInMs: cacheENV.CACHE_BREAKER_RESET_TIMEOUT_MS
      },
      ...(cacheENV.CACHE_MASTER_URL !== undefined && { masterUrl: cacheENV.CACHE_MASTER_URL }),
      ...(cacheENV.CACHE_REPLICA_URLS.length > 0 && { replicaUrls: cacheENV.CACHE_REPLICA_URLS })
    }),

    DatabaseModule.forRoot({
      connectionString: withSchema(databaseENV.DATABASE_URL)
    }),

    HealthModule
  ],
  controllers: [],
  providers: []
})
export class AppModule {}
```

- [ ] **Step 5: Update the health e2e test and add a database-down variant**

`apps/ses-webhook-ingestor/src/health/__tests__/health.controller.e2e.ts` (full replacement — needs `DATABASE_URL` stubbed too, and now runs against real Postgres):

```ts
import { type INestApplication } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../app.module.ts'

vi.hoisted(() => {
  process.env.CACHE_PREFIX = 'ruguin:e2e'
  process.env.CACHE_DRIVER = 'memory'
  process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin'
})

describe('GET /health', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()

    app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.init()
    await (app as unknown as NestFastifyApplication).getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 200 with cache and database reported as up', async () => {
    const response = await (app as unknown as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toMatchObject({
      status: 'ok',
      info: { cache: { status: 'up' }, database: { status: 'up' } }
    })
  })
})
```

`apps/ses-webhook-ingestor/src/health/__tests__/health.controller.database-down.e2e.ts`:

```ts
import { type INestApplication } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../app.module.ts'

vi.hoisted(() => {
  process.env.CACHE_PREFIX = 'ruguin:e2e-db-down'
  process.env.CACHE_DRIVER = 'memory'
  // Deliberately unreachable — proves the health check reports "down" instead of hanging or throwing.
  process.env.DATABASE_URL = 'postgresql://ruguin:ruguin@localhost:1/ruguin'
})

describe('GET /health with Postgres unreachable', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()

    app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.init()
    await (app as unknown as NestFastifyApplication).getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 503 with database reported as down', async () => {
    const response = await (app as unknown as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.payload)).toMatchObject({ status: 'error', error: { database: { status: 'down' } } })
  }, 15_000)
})
```

- [ ] **Step 6: Run tests to verify they fail, then pass**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test:e2e`
Expected first (before Step 3/4 code exists): FAIL — `DatabaseHealthIndicator`/`DatabaseModule` not found.

After Steps 3–5: Run `pnpm --filter @ruguin/ses-webhook-ingestor build && pnpm --filter @ruguin/ses-webhook-ingestor test:e2e`
Expected: PASS (requires `docker compose -f infrastructure/local/docker-compose.yml up -d postgres`).

- [ ] **Step 7: Commit**

```bash
git add apps/ses-webhook-ingestor
git commit -m "feat(ses-webhook-ingestor): add Postgres correlation schema, PrismaService, DB health check"
```

---

## Task 6: EventBridge SES notification schema + pure `eventType → status` mapping

**Files:**
- Create: `apps/ses-webhook-ingestor/src/ses-notification/presentation/dto/eventbridge-ses-notification.schema.ts`
- Test: `apps/ses-webhook-ingestor/src/ses-notification/presentation/dto/__tests__/eventbridge-ses-notification.schema.unit.ts`
- Create: `apps/ses-webhook-ingestor/src/ses-notification/domain/map-ses-event-to-status.ts`
- Test: `apps/ses-webhook-ingestor/src/ses-notification/domain/__tests__/map-ses-event-to-status.unit.ts`

**Interfaces:**
- Consumes: `EmailStatusUpdatedStatus`, `SesBounceType` from `@ruguin/event-schemas` (Task 1).
- Produces: `EventBridgeSesNotificationSchema` (Zod, exported type `EventBridgeSesNotification`) validating `{ id: string, source: 'aws.ses', detail: { eventType: 'Bounce', mail: {messageId}, bounce: {bounceType} } | { eventType: 'Delivery'|'Complaint', mail: {messageId} } }`. `mapSesEventToStatus(detail): { status: 'delivered'|'bounced'|'complained', bounceType?: SesBounceType[keyof] }` — a total, pure function over the three `detail` shapes. Both consumed by `IngestSesNotificationUseCase` (Task 12).

- [ ] **Step 1: Write the failing schema test**

`apps/ses-webhook-ingestor/src/ses-notification/presentation/dto/__tests__/eventbridge-ses-notification.schema.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { EventBridgeSesNotificationSchema } from '../eventbridge-ses-notification.schema.ts'

describe('EventBridgeSesNotificationSchema', () => {
  it('accepts a Delivery notification', () => {
    const result = EventBridgeSesNotificationSchema.safeParse({
      id: 'evt-1',
      source: 'aws.ses',
      detail: { eventType: 'Delivery', mail: { messageId: 'ses-msg-1' } }
    })

    expect(result.success).toBe(true)
  })

  it('accepts a Bounce notification with bounceType', () => {
    const result = EventBridgeSesNotificationSchema.safeParse({
      id: 'evt-2',
      source: 'aws.ses',
      detail: { eventType: 'Bounce', mail: { messageId: 'ses-msg-2' }, bounce: { bounceType: 'Permanent' } }
    })

    expect(result.success).toBe(true)
  })

  it('rejects a Bounce notification missing the bounce object', () => {
    const result = EventBridgeSesNotificationSchema.safeParse({
      id: 'evt-3',
      source: 'aws.ses',
      detail: { eventType: 'Bounce', mail: { messageId: 'ses-msg-3' } }
    })

    expect(result.success).toBe(false)
  })

  it('rejects a source other than aws.ses', () => {
    const result = EventBridgeSesNotificationSchema.safeParse({
      id: 'evt-4',
      source: 'aws.sns',
      detail: { eventType: 'Delivery', mail: { messageId: 'ses-msg-4' } }
    })

    expect(result.success).toBe(false)
  })

  it('rejects an eventType outside Delivery/Bounce/Complaint', () => {
    const result = EventBridgeSesNotificationSchema.safeParse({
      id: 'evt-5',
      source: 'aws.ses',
      detail: { eventType: 'Send', mail: { messageId: 'ses-msg-5' } }
    })

    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the schema**

`apps/ses-webhook-ingestor/src/ses-notification/presentation/dto/eventbridge-ses-notification.schema.ts`:

```ts
import { SesBounceType } from '@ruguin/event-schemas'
import { z } from 'zod'

const SesMailSchema = z.object({ messageId: z.string().min(1) })
const SesBounceDetailSchema = z.object({ bounceType: z.enum(SesBounceType) })

/*
 * A discriminated union, not one object with an optional `bounce` — SES only ever includes the
 * bounce object when eventType=Bounce, and making that structural (rather than "optional and
 * hope it's there") means mapSesEventToStatus never has to guard against a Bounce notification
 * with no bounce detail; the type system already rules that combination out.
 */
const SesEventDetailSchema = z.discriminatedUnion('eventType', [
  z.object({ eventType: z.literal('Bounce'), mail: SesMailSchema, bounce: SesBounceDetailSchema }),
  z.object({ eventType: z.literal('Delivery'), mail: SesMailSchema }),
  z.object({ eventType: z.literal('Complaint'), mail: SesMailSchema })
])

export const EventBridgeSesNotificationSchema = z.object({
  id: z.string().min(1),
  source: z.literal('aws.ses'),
  detail: SesEventDetailSchema
})

export type EventBridgeSesNotification = z.infer<typeof EventBridgeSesNotificationSchema>
export type SesEventDetail = EventBridgeSesNotification['detail']
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: PASS

- [ ] **Step 5: Write the failing test for the pure mapping function**

`apps/ses-webhook-ingestor/src/ses-notification/domain/__tests__/map-ses-event-to-status.unit.ts`:

```ts
import { EmailStatusUpdatedStatus } from '@ruguin/event-schemas'
import { describe, expect, it } from 'vitest'

import { mapSesEventToStatus } from '../map-ses-event-to-status.ts'

describe('mapSesEventToStatus', () => {
  it('maps Delivery to delivered, with no bounceType', () => {
    const result = mapSesEventToStatus({ eventType: 'Delivery', mail: { messageId: 'ses-msg-1' } })

    expect(result).toEqual({ status: EmailStatusUpdatedStatus.DELIVERED })
  })

  it('maps Complaint to complained, with no bounceType', () => {
    const result = mapSesEventToStatus({ eventType: 'Complaint', mail: { messageId: 'ses-msg-1' } })

    expect(result).toEqual({ status: EmailStatusUpdatedStatus.COMPLAINED })
  })

  it('maps Bounce to bounced, carrying bounceType through', () => {
    const result = mapSesEventToStatus({
      eventType: 'Bounce',
      mail: { messageId: 'ses-msg-1' },
      bounce: { bounceType: 'Transient' }
    })

    expect(result).toEqual({ status: EmailStatusUpdatedStatus.BOUNCED, bounceType: 'Transient' })
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: FAIL — module does not exist.

- [ ] **Step 7: Write the mapping function**

`apps/ses-webhook-ingestor/src/ses-notification/domain/map-ses-event-to-status.ts`:

```ts
import { EmailStatusUpdatedStatus, type SesBounceType } from '@ruguin/event-schemas'

import { type SesEventDetail } from '../presentation/dto/eventbridge-ses-notification.schema.ts'

export type MappedSesStatus = Readonly<{
  status: (typeof EmailStatusUpdatedStatus)['DELIVERED' | 'BOUNCED' | 'COMPLAINED']
  bounceType?: (typeof SesBounceType)[keyof typeof SesBounceType]
}>

export function mapSesEventToStatus(detail: SesEventDetail): MappedSesStatus {
  if (detail.eventType === 'Bounce') return { status: EmailStatusUpdatedStatus.BOUNCED, bounceType: detail.bounce.bounceType }
  if (detail.eventType === 'Delivery') return { status: EmailStatusUpdatedStatus.DELIVERED }
  return { status: EmailStatusUpdatedStatus.COMPLAINED }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/ses-webhook-ingestor/src/ses-notification
git commit -m "feat(ses-webhook-ingestor): add EventBridge SES notification schema and status mapping"
```

---

## Task 7: Correlation port + Prisma repository

**Files:**
- Create: `apps/ses-webhook-ingestor/src/ses-notification/domain/errors/correlation-lookup.error.ts`
- Create: `apps/ses-webhook-ingestor/src/ses-notification/domain/errors/correlation-upsert.error.ts`
- Create: `apps/ses-webhook-ingestor/src/ses-notification/application/providers/correlation.port.ts`
- Create: `apps/ses-webhook-ingestor/src/ses-notification/infra/postgres/prisma-correlation.repository.ts`
- Create: `apps/ses-webhook-ingestor/src/shared/infrastructure/database/prisma/__tests__/database-test-context.ts`
- Test: `apps/ses-webhook-ingestor/src/ses-notification/infra/postgres/__tests__/prisma-correlation.repository.int.ts`

**Interfaces:**
- Consumes: `PrismaService` (Task 5).
- Produces: `CORRELATION_PROVIDER` (DI token), `CorrelationPort` interface (`upsert({sesMessageId, emailId}): Promise<Either<BaseError, void>>`, `lookup({sesMessageId}): Promise<Either<BaseError, {emailId: string} | null>>`), `PrismaCorrelationRepository implements CorrelationPort`. `createTestPrismaService()`/`TEST_DATABASE_URL` reusable by every later integration test that needs real Postgres. Consumed by `RecordSentCorrelationUseCase` (Task 9), `IngestSesNotificationUseCase` (Task 12), `ResolvePendingCorrelationUseCase` (Task 14).

- [ ] **Step 1: Write the port and errors (no test — pure type/interface declarations)**

`apps/ses-webhook-ingestor/src/ses-notification/domain/errors/correlation-lookup.error.ts`:

```ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class CorrelationLookupError extends BaseError {
  readonly name = 'CorrelationLookupError'
  readonly status = StatusError.INTERNAL_ERROR

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- required to create public constructor for this subclass
  constructor(input: { message: string; error?: unknown }) {
    super(input)
  }
}
```

`apps/ses-webhook-ingestor/src/ses-notification/domain/errors/correlation-upsert.error.ts`:

```ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class CorrelationUpsertError extends BaseError {
  readonly name = 'CorrelationUpsertError'
  readonly status = StatusError.INTERNAL_ERROR

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- required to create public constructor for this subclass
  constructor(input: { message: string; error?: unknown }) {
    super(input)
  }
}
```

`apps/ses-webhook-ingestor/src/ses-notification/application/providers/correlation.port.ts`:

```ts
import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

export const CORRELATION_PROVIDER = Symbol('CORRELATION_PROVIDER')

export type UpsertCorrelationInput = Readonly<{ sesMessageId: string; emailId: string }>
export type LookupCorrelationInput = Readonly<{ sesMessageId: string }>
export type LookupCorrelationOutput = Readonly<{ emailId: string }> | null

export interface CorrelationPort {
  /* Idempotent by design (ON CONFLICT DO NOTHING semantics) — dispatch-worker's email.status.updated
   * sent event is at-least-once, so this may run more than once for the same sesMessageId. */
  upsert(input: UpsertCorrelationInput): Promise<Either<BaseError, void>>
  lookup(input: LookupCorrelationInput): Promise<Either<BaseError, LookupCorrelationOutput>>
}
```

- [ ] **Step 2: Write the shared Postgres test context**

`apps/ses-webhook-ingestor/src/shared/infrastructure/database/prisma/__tests__/database-test-context.ts` (mirrors `apps/core-server`'s `outbox-test-context.ts`):

```ts
import { PrismaService } from '../prisma.service.ts'

/*
 * Reads a dedicated variable, never the app's own DATABASE_URL — see the identical comment in
 * apps/core-server/src/shared/infrastructure/outbox/__tests__/outbox-test-context.ts. Schema name
 * matches app.module.ts's DATABASE_SCHEMA constant.
 */
export const TEST_DATABASE_URL: string =
  process.env.TEST_DATABASE_URL ?? 'postgresql://ruguin:ruguin@localhost:5432/ruguin?schema=ses_webhook_ingestor'

export const createTestPrismaService = (): PrismaService => new PrismaService(TEST_DATABASE_URL)
```

- [ ] **Step 3: Write the failing integration test**

`apps/ses-webhook-ingestor/src/ses-notification/infra/postgres/__tests__/prisma-correlation.repository.int.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { type PrismaService } from '../../../../shared/infrastructure/database/prisma/prisma.service.ts'
import { createTestPrismaService } from '../../../../shared/infrastructure/database/prisma/__tests__/database-test-context.ts'
import { PrismaCorrelationRepository } from '../prisma-correlation.repository.ts'

const context: { prisma: PrismaService | null } = { prisma: null }

const prisma = (): PrismaService => {
  if (context.prisma === null) throw new Error('prisma was never connected')
  return context.prisma
}

beforeAll(() => {
  context.prisma = createTestPrismaService()
})

afterEach(async () => {
  await prisma().sesMessageCorrelation.deleteMany({ where: { sesMessageId: { startsWith: 'int-test-' } } })
})

afterAll(async () => {
  await prisma().$disconnect()
})

describe('PrismaCorrelationRepository against a live Postgres', () => {
  it('returns null when looking up a sesMessageId that was never recorded', async () => {
    const repository = new PrismaCorrelationRepository(prisma())

    const result = await repository.lookup({ sesMessageId: 'int-test-never-seen' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value).toBeNull()
  })

  it('upserts a correlation and then finds it by lookup', async () => {
    const repository = new PrismaCorrelationRepository(prisma())

    const upserted = await repository.upsert({ sesMessageId: 'int-test-1', emailId: 'email-1' })
    expect(upserted.isSuccess()).toBe(true)

    const found = await repository.lookup({ sesMessageId: 'int-test-1' })
    expect(found.isSuccess()).toBe(true)
    if (found.isSuccess()) expect(found.value).toEqual({ emailId: 'email-1' })
  })

  it('is idempotent under a repeated upsert for the same sesMessageId', async () => {
    const repository = new PrismaCorrelationRepository(prisma())

    await repository.upsert({ sesMessageId: 'int-test-2', emailId: 'email-2' })
    const secondUpsert = await repository.upsert({ sesMessageId: 'int-test-2', emailId: 'email-2' })

    expect(secondUpsert.isSuccess()).toBe(true)

    const rows = await prisma().sesMessageCorrelation.findMany({ where: { sesMessageId: 'int-test-2' } })
    expect(rows).toHaveLength(1)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `docker compose -f infrastructure/local/docker-compose.yml up -d postgres && pnpm --filter @ruguin/ses-webhook-ingestor test:integration`
Expected: FAIL — `PrismaCorrelationRepository` does not exist.

- [ ] **Step 5: Write the repository**

`apps/ses-webhook-ingestor/src/ses-notification/infra/postgres/prisma-correlation.repository.ts`:

```ts
import { Injectable } from '@nestjs/common'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import {
  type CorrelationPort,
  type LookupCorrelationInput,
  type LookupCorrelationOutput,
  type UpsertCorrelationInput
} from '../../application/providers/correlation.port.ts'
import { CorrelationLookupError } from '../../domain/errors/correlation-lookup.error.ts'
import { CorrelationUpsertError } from '../../domain/errors/correlation-upsert.error.ts'
import { type PrismaService } from '../../../shared/infrastructure/database/prisma/prisma.service.ts'

@Injectable()
export class PrismaCorrelationRepository implements CorrelationPort {
  constructor(private readonly prisma: PrismaService) {}

  public async upsert(input: UpsertCorrelationInput): Promise<Either<BaseError, void>> {
    try {
      await this.prisma.sesMessageCorrelation.upsert({
        where: { sesMessageId: input.sesMessageId },
        create: { sesMessageId: input.sesMessageId, emailId: input.emailId },
        // A conflict means this sesMessageId was already recorded — the row's emailId doesn't
        // change for a given SES message id, so there is nothing new to write on conflict.
        update: {}
      })

      return success(undefined)
    } catch (error: unknown) {
      return failure(
        new CorrelationUpsertError({ error, message: `Failed to upsert correlation for sesMessageId "${input.sesMessageId}".` })
      )
    }
  }

  public async lookup(input: LookupCorrelationInput): Promise<Either<BaseError, LookupCorrelationOutput>> {
    try {
      const found = await this.prisma.sesMessageCorrelation.findUnique({ where: { sesMessageId: input.sesMessageId } })

      return success(found === null ? null : { emailId: found.emailId })
    } catch (error: unknown) {
      return failure(
        new CorrelationLookupError({ error, message: `Failed to look up correlation for sesMessageId "${input.sesMessageId}".` })
      )
    }
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test:integration`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/ses-webhook-ingestor/src/ses-notification apps/ses-webhook-ingestor/src/shared/infrastructure/database/prisma/__tests__
git commit -m "feat(ses-webhook-ingestor): add correlation port and Prisma repository"
```

---

## Task 8: Redis dedup claim port + implementation

**Files:**
- Create: `apps/ses-webhook-ingestor/src/ses-notification/application/providers/dedup-claim.port.ts`
- Create: `apps/ses-webhook-ingestor/src/ses-notification/infra/redis/redis-dedup-claim.ts`
- Test: `apps/ses-webhook-ingestor/src/ses-notification/infra/redis/__tests__/redis-dedup-claim.unit.ts`

**Interfaces:**
- Consumes: `ICacheProvider`/`InjectCache` from `@ruguin/cache` (already wired via `CacheModule.forRoot` in Task 3/5).
- Produces: `DEDUP_CLAIM_PROVIDER` (DI token), `DedupClaimPort` (`claim({key, ttlInMs}): Promise<Either<BaseError,{claimed:boolean}>>`, `release({key}): Promise<Either<BaseError,void>>`), `RedisDedupClaim implements DedupClaimPort`. Consumed by `IngestSesNotificationUseCase` (Task 12) to dedup incoming EventBridge notifications by their `id`.

- [ ] **Step 1: Write the port (no test — pure interface)**

`apps/ses-webhook-ingestor/src/ses-notification/application/providers/dedup-claim.port.ts` (identical shape to `apps/dispatch-worker`'s):

```ts
import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

export const DEDUP_CLAIM_PROVIDER = Symbol('DEDUP_CLAIM_PROVIDER')

export type DedupClaimInput = Readonly<{ key: string; ttlInMs: number }>
export type DedupClaimOutput = Readonly<{ claimed: boolean }>
export type ReleaseClaimInput = Readonly<{ key: string }>

export interface DedupClaimPort {
  claim(input: DedupClaimInput): Promise<Either<BaseError, DedupClaimOutput>>
  /*
   * Frees a claim early when IngestSesNotificationUseCase is about to report failure for an
   * already-claimed EventBridge event id (a downstream Kafka publish failed) — same reasoning as
   * apps/dispatch-worker/src/email/application/providers/dedup-claim.port.ts's release().
   */
  release(input: ReleaseClaimInput): Promise<Either<BaseError, void>>
}
```

- [ ] **Step 2: Write the failing unit test**

`apps/ses-webhook-ingestor/src/ses-notification/infra/redis/__tests__/redis-dedup-claim.unit.ts`:

```ts
import { type ICacheProvider } from '@ruguin/cache'
import { success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { RedisDedupClaim } from '../redis-dedup-claim.ts'

function fakeCache(overrides: Partial<Pick<ICacheProvider, 'setIfNotExists' | 'delete'>>): ICacheProvider {
  return overrides as unknown as ICacheProvider
}

describe('RedisDedupClaim', () => {
  it('claims an EventBridge event id that has never been claimed before', async () => {
    const setIfNotExists = vi.fn().mockResolvedValue(success({ stored: true }))
    const claim = new RedisDedupClaim(fakeCache({ setIfNotExists }))

    const result = await claim.claim({ key: 'evt-1', ttlInMs: 300_000 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.claimed).toBe(true)
    expect(setIfNotExists).toHaveBeenCalledWith({
      key: 'evt-1',
      namespace: 'ses-webhook-ingestor-dedup',
      value: true,
      ttlInMs: 300_000
    })
  })

  it('does not claim an event id that is already claimed', async () => {
    const setIfNotExists = vi.fn().mockResolvedValue(success({ stored: false }))
    const claim = new RedisDedupClaim(fakeCache({ setIfNotExists }))

    const result = await claim.claim({ key: 'evt-1', ttlInMs: 300_000 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.claimed).toBe(false)
  })

  it('propagates a failure from the underlying cache when claiming', async () => {
    const cacheError = { name: 'CacheOperationError', message: 'connection reset' }
    const setIfNotExists = vi
      .fn()
      .mockResolvedValue({ isFailure: () => true, isSuccess: () => false, value: cacheError })
    const claim = new RedisDedupClaim(fakeCache({ setIfNotExists }))

    const result = await claim.claim({ key: 'evt-1', ttlInMs: 300_000 })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(cacheError)
  })

  it('releases a claimed event id so a later redelivery can claim it again', async () => {
    const deleteFunction = vi.fn().mockResolvedValue(success({ existed: true }))
    const claim = new RedisDedupClaim(fakeCache({ delete: deleteFunction }))

    const result = await claim.release({ key: 'evt-1' })

    expect(result.isSuccess()).toBe(true)
    expect(deleteFunction).toHaveBeenCalledWith({ key: 'evt-1', namespace: 'ses-webhook-ingestor-dedup' })
  })

  it('propagates a failure from the underlying cache when releasing', async () => {
    const cacheError = { name: 'CacheOperationError', message: 'connection reset' }
    const deleteFunction = vi
      .fn()
      .mockResolvedValue({ isFailure: () => true, isSuccess: () => false, value: cacheError })
    const claim = new RedisDedupClaim(fakeCache({ delete: deleteFunction }))

    const result = await claim.release({ key: 'evt-1' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(cacheError)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: FAIL — `RedisDedupClaim` does not exist.

- [ ] **Step 4: Write the implementation**

`apps/ses-webhook-ingestor/src/ses-notification/infra/redis/redis-dedup-claim.ts`:

```ts
import { Injectable } from '@nestjs/common'
import { type ICacheProvider, InjectCache } from '@ruguin/cache'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import {
  type DedupClaimInput,
  type DedupClaimOutput,
  type DedupClaimPort,
  type ReleaseClaimInput
} from '../../application/providers/dedup-claim.port.ts'

/* KeyBuilder forbids ":" in namespace segments (packages/cache/src/infra/key-builder.ts). */
const NAMESPACE = 'ses-webhook-ingestor-dedup'

@Injectable()
export class RedisDedupClaim implements DedupClaimPort {
  constructor(@InjectCache() private readonly cache: ICacheProvider) {}

  public async claim(input: DedupClaimInput): Promise<Either<BaseError, DedupClaimOutput>> {
    const result = await this.cache.setIfNotExists({
      key: input.key,
      namespace: NAMESPACE,
      value: true,
      ttlInMs: input.ttlInMs
    })

    if (result.isFailure()) return failure(result.value)

    return success({ claimed: result.value.stored })
  }

  public async release(input: ReleaseClaimInput): Promise<Either<BaseError, void>> {
    const result = await this.cache.delete({ key: input.key, namespace: NAMESPACE })

    if (result.isFailure()) return failure(result.value)

    return success(undefined)
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/ses-webhook-ingestor/src/ses-notification/application/providers/dedup-claim.port.ts apps/ses-webhook-ingestor/src/ses-notification/infra/redis
git commit -m "feat(ses-webhook-ingestor): add Redis dedup claim for EventBridge event ids"
```

---

## Task 9: `RecordSentCorrelationUseCase` + `email.status.updated` consumer — wires Kafka into `app.module.ts`

**Files:**
- Create: `apps/ses-webhook-ingestor/src/ses-notification/application/use-cases/record-sent-correlation.use-case.ts`
- Test: `apps/ses-webhook-ingestor/src/ses-notification/application/use-cases/__tests__/record-sent-correlation.use-case.unit.ts`
- Create: `apps/ses-webhook-ingestor/src/shared/infrastructure/message-broker/message-broker-module-options.ts`
- Create: `apps/ses-webhook-ingestor/src/ses-notification/consumers/email-status-updated-sent.consumer.ts`
- Create: `apps/ses-webhook-ingestor/src/ses-notification/ses-notification.module.ts`
- Modify: `apps/ses-webhook-ingestor/src/app.module.ts`
- Test: `apps/ses-webhook-ingestor/src/ses-notification/consumers/__tests__/email-status-updated-sent.consumer.int.ts`

**Interfaces:**
- Consumes: `CORRELATION_PROVIDER`/`CorrelationPort` (Task 7), `PrismaCorrelationRepository` (Task 7), `MESSAGE_CONSUMER_PORT`/`MESSAGE_PRODUCER_PORT` (`@ruguin/message-broker`), `EMAIL_STATUS_UPDATED_TOPIC`/`EMAIL_STATUS_UPDATED_DLQ_TOPIC`/`EmailStatusUpdatedPayloadSchema`/`EmailStatusUpdatedStatus` (`@ruguin/event-schemas`).
- Produces: `RecordSentCorrelationUseCase.execute({sesMessageId, emailId}): Promise<Either<BaseError,void>>`, `EmailStatusUpdatedSentConsumer` (Kafka consumer, group id `ses-webhook-ingestor-correlation`), `SesNotificationModule` (first cut — extended by Tasks 12–14). `AppModule` now boots Kafka.

- [ ] **Step 1: Write the failing unit test for the use case**

`apps/ses-webhook-ingestor/src/ses-notification/application/use-cases/__tests__/record-sent-correlation.use-case.unit.ts`:

```ts
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type CorrelationPort } from '../../providers/correlation.port.ts'
import { RecordSentCorrelationUseCase } from '../record-sent-correlation.use-case.ts'

function fakeCorrelation(overrides: Partial<CorrelationPort>): CorrelationPort {
  return overrides as unknown as CorrelationPort
}

describe('RecordSentCorrelationUseCase', () => {
  it('upserts the correlation with the given sesMessageId and emailId', async () => {
    const upsert = vi.fn().mockResolvedValue(success(undefined))
    const useCase = new RecordSentCorrelationUseCase(fakeCorrelation({ upsert }))

    const result = await useCase.execute({ sesMessageId: 'ses-msg-1', emailId: 'email-1' })

    expect(result.isSuccess()).toBe(true)
    expect(upsert).toHaveBeenCalledWith({ sesMessageId: 'ses-msg-1', emailId: 'email-1' })
  })

  it('propagates a failure from the correlation port', async () => {
    const correlationError = { name: 'CorrelationUpsertError', message: 'db down' }
    const upsert = vi.fn().mockResolvedValue(failure(correlationError))
    const useCase = new RecordSentCorrelationUseCase(fakeCorrelation({ upsert }))

    const result = await useCase.execute({ sesMessageId: 'ses-msg-1', emailId: 'email-1' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(correlationError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: FAIL — `RecordSentCorrelationUseCase` does not exist.

- [ ] **Step 3: Write the use case**

`apps/ses-webhook-ingestor/src/ses-notification/application/use-cases/record-sent-correlation.use-case.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

import { CORRELATION_PROVIDER, type CorrelationPort } from '../providers/correlation.port.ts'

export type RecordSentCorrelationInput = Readonly<{ sesMessageId: string; emailId: string }>

@Injectable()
export class RecordSentCorrelationUseCase {
  constructor(@Inject(CORRELATION_PROVIDER) private readonly correlation: CorrelationPort) {}

  public execute(input: RecordSentCorrelationInput): Promise<Either<BaseError, void>> {
    return this.correlation.upsert(input)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: PASS

- [ ] **Step 5: Write the Kafka wiring, the consumer, and the module**

`apps/ses-webhook-ingestor/src/shared/infrastructure/message-broker/message-broker-module-options.ts` (identical to `apps/dispatch-worker`'s):

```ts
import { messageBrokerENV } from '@ruguin/env'
import { type MessageBrokerModuleOptions } from '@ruguin/message-broker'

export function createMessageBrokerModuleOptions(): MessageBrokerModuleOptions {
  const brokers = messageBrokerENV.KAFKA_BOOTSTRAP_BROKERS.split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0)

  if (brokers.length === 0) {
    throw new Error('KAFKA_BOOTSTRAP_BROKERS must contain at least one non-empty broker after trimming.')
  }

  return {
    brokers,
    clientId: messageBrokerENV.KAFKA_CLIENT_ID,
    ssl: messageBrokerENV.KAFKA_SSL,
    autoCreateTopics: true
  }
}
```

`apps/ses-webhook-ingestor/src/ses-notification/consumers/email-status-updated-sent.consumer.ts`:

```ts
import { randomUUID } from 'node:crypto'

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import {
  EMAIL_STATUS_UPDATED_DLQ_TOPIC,
  EMAIL_STATUS_UPDATED_TOPIC,
  EmailStatusUpdatedPayloadSchema,
  EmailStatusUpdatedStatus
} from '@ruguin/event-schemas'
import {
  MESSAGE_CONSUMER_PORT,
  MESSAGE_PRODUCER_PORT,
  type MessageConsumerPort,
  type MessageProducerPort
} from '@ruguin/message-broker'
import { failure, success } from '@ruguin/utils'

import { RecordSentCorrelationUseCase } from '../application/use-cases/record-sent-correlation.use-case.ts'

export const CORRELATION_CONSUMER_GROUP_ID = 'ses-webhook-ingestor-correlation'

@Injectable()
export class EmailStatusUpdatedSentConsumer implements OnModuleInit {
  private readonly logger = new Logger(EmailStatusUpdatedSentConsumer.name)

  constructor(
    @Inject(MESSAGE_CONSUMER_PORT) private readonly consumer: MessageConsumerPort,
    @Inject(MESSAGE_PRODUCER_PORT) private readonly producer: MessageProducerPort,
    private readonly recordSentCorrelation: RecordSentCorrelationUseCase
  ) {}

  public async onModuleInit(): Promise<void> {
    await this.consumer.subscribe({
      topic: EMAIL_STATUS_UPDATED_TOPIC,
      groupId: CORRELATION_CONSUMER_GROUP_ID,
      onMessage: async (message) => {
        const parsed = EmailStatusUpdatedPayloadSchema.safeParse(message.payload)
        if (!parsed.success) {
          this.logger.warn(`Malformed email.status.updated payload (eventId=${message.eventId}); routing to DLQ.`)
          return this.producer.publish({
            topic: EMAIL_STATUS_UPDATED_DLQ_TOPIC,
            key: message.eventId,
            message: { eventId: randomUUID(), name: 'email.status.updated', payload: message.payload },
            headers: message.headers
          })
        }

        /*
         * Only status=sent (published by dispatch-worker) carries the emailId+sesMessageId pair
         * this table exists to record. Every other status on this topic — including
         * delivered/bounced/complained, which this app itself publishes — has nothing to
         * correlate, so it's skipped, not an error.
         */
        if (parsed.data.status !== EmailStatusUpdatedStatus.SENT || parsed.data.sesMessageId === undefined) {
          return success(undefined)
        }

        const result = await this.recordSentCorrelation.execute({
          sesMessageId: parsed.data.sesMessageId,
          emailId: parsed.data.emailId
        })
        if (result.isFailure()) return failure(result.value)

        return success(undefined)
      }
    })
  }
}
```

`apps/ses-webhook-ingestor/src/ses-notification/ses-notification.module.ts` (first cut — grows in Tasks 12–14):

```ts
import { Module } from '@nestjs/common'

import { CORRELATION_PROVIDER } from './application/providers/correlation.port.ts'
import { RecordSentCorrelationUseCase } from './application/use-cases/record-sent-correlation.use-case.ts'
import { EmailStatusUpdatedSentConsumer } from './consumers/email-status-updated-sent.consumer.ts'
import { PrismaCorrelationRepository } from './infra/postgres/prisma-correlation.repository.ts'

@Module({
  providers: [
    { provide: CORRELATION_PROVIDER, useClass: PrismaCorrelationRepository },
    RecordSentCorrelationUseCase,
    EmailStatusUpdatedSentConsumer
  ]
})
export class SesNotificationModule {}
```

`apps/ses-webhook-ingestor/src/app.module.ts` (full replacement — adds `MessageBrokerModule` and `SesNotificationModule`):

```ts
import { Module } from '@nestjs/common'
import { CacheModule } from '@ruguin/cache'
import { cacheENV, databaseENV } from '@ruguin/env'
import { MessageBrokerModule } from '@ruguin/message-broker'
import { LoggerModule } from 'nestjs-pino'

import { HealthModule } from './health/health.module.ts'
import { DatabaseModule } from './shared/infrastructure/database/database.module.ts'
import { createPinoHttpOptions } from './shared/infrastructure/logger/pino-http-options.ts'
import { createMessageBrokerModuleOptions } from './shared/infrastructure/message-broker/message-broker-module-options.ts'
import { SesNotificationModule } from './ses-notification/ses-notification.module.ts'

const DATABASE_SCHEMA = 'ses_webhook_ingestor'

export function withSchema(connectionString: string): string {
  const separator = connectionString.includes('?') ? '&' : '?'
  return `${connectionString}${separator}schema=${DATABASE_SCHEMA}`
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => ({
        pinoHttp: createPinoHttpOptions()
      })
    }),

    CacheModule.forRoot({
      isGlobal: true,
      driver: cacheENV.CACHE_DRIVER,
      jitterRatio: cacheENV.CACHE_JITTER_RATIO,
      defaultTtlInMs: cacheENV.CACHE_DEFAULT_TTL_MS,
      defaultConsistency: cacheENV.CACHE_DEFAULT_CONSISTENCY,
      invalidationBroadcast: cacheENV.CACHE_INVALIDATION_BROADCAST,
      prefix: cacheENV.CACHE_PREFIX,
      negativeTtlInMs: cacheENV.CACHE_NEGATIVE_TTL_MS,
      lockTtlInMs: cacheENV.CACHE_OPERATION_TIMEOUT_MS * 10,
      operationTimeoutInMs: cacheENV.CACHE_OPERATION_TIMEOUT_MS,
      namespaceVersionLocalTtlInMs: cacheENV.CACHE_NS_VERSION_LOCAL_TTL_MS,
      replicationLagThresholdInBytes: cacheENV.CACHE_REPLICATION_LAG_THRESHOLD_BYTES,
      breaker: {
        failureThreshold: cacheENV.CACHE_BREAKER_FAILURE_THRESHOLD,
        resetTimeoutInMs: cacheENV.CACHE_BREAKER_RESET_TIMEOUT_MS
      },
      ...(cacheENV.CACHE_MASTER_URL !== undefined && { masterUrl: cacheENV.CACHE_MASTER_URL }),
      ...(cacheENV.CACHE_REPLICA_URLS.length > 0 && { replicaUrls: cacheENV.CACHE_REPLICA_URLS })
    }),

    MessageBrokerModule.forRoot({ isGlobal: true, ...createMessageBrokerModuleOptions() }),

    DatabaseModule.forRoot({
      connectionString: withSchema(databaseENV.DATABASE_URL)
    }),

    SesNotificationModule,
    HealthModule
  ],
  controllers: [],
  providers: []
})
export class AppModule {}
```

- [ ] **Step 6: Write the failing integration test**

`apps/ses-webhook-ingestor/src/ses-notification/consumers/__tests__/email-status-updated-sent.consumer.int.ts`:

```ts
import { randomUUID } from 'node:crypto'

import { Test, type TestingModule } from '@nestjs/testing'
import { EMAIL_STATUS_UPDATED_TOPIC } from '@ruguin/event-schemas'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '@ruguin/message-broker'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../../app.module.ts'
import { createTestPrismaService } from '../../../shared/infrastructure/database/prisma/__tests__/database-test-context.ts'
import { type PrismaService } from '../../../shared/infrastructure/database/prisma/prisma.service.ts'

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin'
})

describe('EmailStatusUpdatedSentConsumer (real Kafka + Postgres)', () => {
  let moduleReference: TestingModule
  let prisma: PrismaService

  beforeAll(() => {
    prisma = createTestPrismaService()
  })

  afterEach(async () => {
    await moduleReference.close()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('records a correlation row when a sent status event is consumed', async () => {
    moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()
    await moduleReference.init()

    const producer = moduleReference.get<MessageProducerPort>(MESSAGE_PRODUCER_PORT)
    const emailId = randomUUID()
    const sesMessageId = `int-test-sent-${randomUUID()}`

    await producer.publish({
      topic: EMAIL_STATUS_UPDATED_TOPIC,
      key: emailId,
      message: { eventId: 'evt-sent-1', name: 'email.status.updated', payload: { emailId, status: 'sent', sesMessageId } }
    })

    await vi.waitUntil(
      async () => (await prisma.sesMessageCorrelation.findUnique({ where: { sesMessageId } })) !== null,
      { timeout: 15_000, interval: 200 }
    )

    const row = await prisma.sesMessageCorrelation.findUnique({ where: { sesMessageId } })
    expect(row).toMatchObject({ sesMessageId, emailId })

    await prisma.sesMessageCorrelation.delete({ where: { sesMessageId } })
  }, 20_000)
})
```

- [ ] **Step 7: Run test to verify it fails, then passes**

Run: `docker compose -f infrastructure/local/docker-compose.yml up -d kafka postgres && pnpm --filter @ruguin/ses-webhook-ingestor build && pnpm --filter @ruguin/ses-webhook-ingestor test:integration`
Expected first (before the consumer/module wiring existed): FAIL. After Steps 3–5: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/ses-webhook-ingestor/src
git commit -m "feat(ses-webhook-ingestor): consume email.status.updated sent events into the correlation table"
```

---

## Task 10: Auth guard for the webhook endpoint

**Files:**
- Create: `apps/ses-webhook-ingestor/src/ses-notification/presentation/ses-webhook-auth.guard.ts`
- Test: `apps/ses-webhook-ingestor/src/ses-notification/presentation/__tests__/ses-webhook-auth.guard.unit.ts`

**Interfaces:**
- Consumes: `sesWebhookIngestorENV.SES_WEBHOOK_INGESTOR_SHARED_SECRET` (Task 4).
- Produces: `SES_INGESTOR_SECRET_HEADER` (`'x-ses-ingestor-key'`), `isValidSharedSecret(candidate, expected): boolean` (pure, timing-safe), `SesWebhookAuthGuard implements CanActivate`. Consumed by `SesWebhookController` (Task 13) via `@UseGuards(SesWebhookAuthGuard)`.

- [ ] **Step 1: Write the failing test**

`apps/ses-webhook-ingestor/src/ses-notification/presentation/__tests__/ses-webhook-auth.guard.unit.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.SES_WEBHOOK_INGESTOR_SHARED_SECRET = 'correct-secret'
  process.env.ENVIRONMENT = 'test'
  process.env.CACHE_PREFIX = 'ruguin:ses-webhook-ingestor-test'
  process.env.KAFKA_BOOTSTRAP_BROKERS = 'localhost:9092'
  process.env.DATABASE_URL = 'postgresql://ruguin:ruguin@localhost:5432/ruguin'
})

import { type ExecutionContext } from '@nestjs/common'

import { isValidSharedSecret, SES_INGESTOR_SECRET_HEADER, SesWebhookAuthGuard } from '../ses-webhook-auth.guard.ts'

function fakeContext(headers: Record<string, string | string[] | undefined>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as unknown as ExecutionContext
}

describe('isValidSharedSecret', () => {
  it('accepts a candidate equal to the expected secret', () => {
    expect(isValidSharedSecret('correct-secret', 'correct-secret')).toBe(true)
  })

  it('rejects an undefined candidate', () => {
    expect(isValidSharedSecret(undefined, 'correct-secret')).toBe(false)
  })

  it('rejects a candidate of a different length without throwing', () => {
    expect(isValidSharedSecret('short', 'a-much-longer-secret')).toBe(false)
  })

  it('rejects a same-length candidate that differs', () => {
    expect(isValidSharedSecret('wrong-secret', 'right-secret')).toBe(false)
  })
})

describe('SesWebhookAuthGuard', () => {
  it('allows a request carrying the correct secret header', () => {
    const guard = new SesWebhookAuthGuard()

    expect(guard.canActivate(fakeContext({ [SES_INGESTOR_SECRET_HEADER]: 'correct-secret' }))).toBe(true)
  })

  it('rejects a request with a missing header', () => {
    const guard = new SesWebhookAuthGuard()

    expect(() => guard.canActivate(fakeContext({}))).toThrow()
  })

  it('rejects a request with the wrong secret', () => {
    const guard = new SesWebhookAuthGuard()

    expect(() => guard.canActivate(fakeContext({ [SES_INGESTOR_SECRET_HEADER]: 'wrong' }))).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: FAIL — `SesWebhookAuthGuard` does not exist.

- [ ] **Step 3: Write the guard**

`apps/ses-webhook-ingestor/src/ses-notification/presentation/ses-webhook-auth.guard.ts`:

```ts
import { timingSafeEqual } from 'node:crypto'

import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { sesWebhookIngestorENV } from '@ruguin/env'

export const SES_INGESTOR_SECRET_HEADER = 'x-ses-ingestor-key'

/*
 * timingSafeEqual throws on a length mismatch instead of returning false — the explicit length
 * check both avoids that crash AND keeps this timing-safe: a naive candidateBuffer.length ===
 * expectedBuffer.length short-circuit before ever calling timingSafeEqual is the only length
 * check that doesn't itself leak content, since Buffer.from(candidate).length depends only on the
 * attacker-supplied header, never on the secret.
 */
export function isValidSharedSecret(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined) return false

  const candidateBuffer = Buffer.from(candidate)
  const expectedBuffer = Buffer.from(expected)

  if (candidateBuffer.length !== expectedBuffer.length) return false

  return timingSafeEqual(candidateBuffer, expectedBuffer)
}

type MinimalRequest = Readonly<{ headers: Record<string, string | string[] | undefined> }>

@Injectable()
export class SesWebhookAuthGuard implements CanActivate {
  public canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<MinimalRequest>()
    const header = request.headers[SES_INGESTOR_SECRET_HEADER]
    const candidate = Array.isArray(header) ? header[0] : header

    if (!isValidSharedSecret(candidate, sesWebhookIngestorENV.SES_WEBHOOK_INGESTOR_SHARED_SECRET)) {
      throw new UnauthorizedException()
    }

    return true
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/ses-webhook-ingestor/src/ses-notification/presentation/ses-webhook-auth.guard.ts apps/ses-webhook-ingestor/src/ses-notification/presentation/__tests__/ses-webhook-auth.guard.unit.ts
git commit -m "feat(ses-webhook-ingestor): add shared-secret auth guard for the webhook endpoint"
```

---

## Task 11: DLQ routing helpers (malformed notification + exhausted correlation retry)

**Files:**
- Create: `apps/ses-webhook-ingestor/src/ses-notification/consumers/dlq-routing.ts`
- Test: `apps/ses-webhook-ingestor/src/ses-notification/consumers/__tests__/dlq-routing.unit.ts`

**Interfaces:**
- Consumes: `SES_NOTIFICATION_MALFORMED_DLQ_TOPIC`, `SES_NOTIFICATION_CORRELATION_DLQ_TOPIC` (Task 2), `MessageProducerPort` (`@ruguin/message-broker`).
- Produces: `publishMalformedNotificationToDlq(producer, {rawBody, reason}): Promise<Either<BaseError,void>>`, `publishExhaustedCorrelationToDlq(producer, {sesMessageId, status, bounceType?, attempt}): Promise<Either<BaseError,void>>`. Both consumed by `IngestSesNotificationUseCase` (Task 12) and `ResolvePendingCorrelationUseCase`/`SesNotificationCorrelationRetryConsumer` (Task 14).

- [ ] **Step 1: Write the failing test**

`apps/ses-webhook-ingestor/src/ses-notification/consumers/__tests__/dlq-routing.unit.ts`:

```ts
import { SES_NOTIFICATION_CORRELATION_DLQ_TOPIC, SES_NOTIFICATION_MALFORMED_DLQ_TOPIC } from '@ruguin/event-schemas'
import { type MessageProducerPort } from '@ruguin/message-broker'
import { success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { publishExhaustedCorrelationToDlq, publishMalformedNotificationToDlq } from '../dlq-routing.ts'

describe('publishMalformedNotificationToDlq', () => {
  it('publishes the raw body and reason to the malformed DLQ topic', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const producer = { publish } as unknown as MessageProducerPort

    await publishMalformedNotificationToDlq(producer, { rawBody: { some: 'body' }, reason: 'invalid envelope' })

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: SES_NOTIFICATION_MALFORMED_DLQ_TOPIC,
        key: expect.any(String),
        message: expect.objectContaining({
          name: 'ses.notification.malformed',
          payload: { rawBody: { some: 'body' }, reason: 'invalid envelope' }
        })
      })
    )
  })
})

describe('publishExhaustedCorrelationToDlq', () => {
  it('publishes to the correlation DLQ topic keyed by sesMessageId, with attempt in headers', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const producer = { publish } as unknown as MessageProducerPort

    await publishExhaustedCorrelationToDlq(producer, { sesMessageId: 'ses-msg-1', status: 'bounced', attempt: 6 })

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: SES_NOTIFICATION_CORRELATION_DLQ_TOPIC,
        key: 'ses-msg-1',
        headers: { attempt: '6' },
        message: expect.objectContaining({
          name: 'ses.notification.correlation.pending',
          payload: { sesMessageId: 'ses-msg-1', status: 'bounced' }
        })
      })
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the helpers**

`apps/ses-webhook-ingestor/src/ses-notification/consumers/dlq-routing.ts`:

```ts
import { randomUUID } from 'node:crypto'

import { SES_NOTIFICATION_CORRELATION_DLQ_TOPIC, SES_NOTIFICATION_MALFORMED_DLQ_TOPIC } from '@ruguin/event-schemas'
import { type MessageProducerPort } from '@ruguin/message-broker'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

/*
 * Keyed by a fresh random id, not anything from the body — a malformed payload can't be trusted
 * to carry any usable identifier (that's exactly why it's here).
 */
export function publishMalformedNotificationToDlq(
  producer: MessageProducerPort,
  input: { rawBody: unknown; reason: string }
): Promise<Either<BaseError, void>> {
  return producer.publish({
    topic: SES_NOTIFICATION_MALFORMED_DLQ_TOPIC,
    key: randomUUID(),
    message: {
      eventId: randomUUID(),
      name: 'ses.notification.malformed',
      payload: { rawBody: input.rawBody, reason: input.reason }
    }
  })
}

export type ExhaustedCorrelationInput = Readonly<{
  sesMessageId: string
  status: string
  bounceType?: string
  attempt: number
}>

export function publishExhaustedCorrelationToDlq(
  producer: MessageProducerPort,
  input: ExhaustedCorrelationInput
): Promise<Either<BaseError, void>> {
  /* attempt lives only in headers (matching EMAIL_SEND_REQUESTED_RETRY_TOPIC's convention) — the
   * payload stays within SesNotificationCorrelationPendingPayloadSchema's shape (Task 2). */
  const { attempt, ...payload } = input

  return producer.publish({
    topic: SES_NOTIFICATION_CORRELATION_DLQ_TOPIC,
    key: input.sesMessageId,
    message: { eventId: randomUUID(), name: 'ses.notification.correlation.pending', payload },
    headers: { attempt: String(attempt) }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/ses-webhook-ingestor/src/ses-notification/consumers/dlq-routing.ts apps/ses-webhook-ingestor/src/ses-notification/consumers/__tests__/dlq-routing.unit.ts
git commit -m "feat(ses-webhook-ingestor): add malformed and exhausted-retry DLQ routing helpers"
```

---

## Task 12: `IngestSesNotificationUseCase` (the HTTP-path orchestrator)

**Files:**
- Create: `apps/ses-webhook-ingestor/src/ses-notification/application/correlation-retry-backoff.ts`
- Test: `apps/ses-webhook-ingestor/src/ses-notification/application/__tests__/correlation-retry-backoff.unit.ts`
- Create: `apps/ses-webhook-ingestor/src/ses-notification/application/use-cases/ingest-ses-notification.use-case.ts`
- Test: `apps/ses-webhook-ingestor/src/ses-notification/application/use-cases/__tests__/ingest-ses-notification.use-case.unit.ts`

**Interfaces:**
- Consumes: `EventBridgeSesNotificationSchema`/`mapSesEventToStatus` (Task 6), `CorrelationPort`/`CORRELATION_PROVIDER` (Task 7), `DedupClaimPort`/`DEDUP_CLAIM_PROVIDER` (Task 8), `publishMalformedNotificationToDlq` (Task 11), `MESSAGE_PRODUCER_PORT` (`@ruguin/message-broker`), `EMAIL_STATUS_UPDATED_TOPIC`/`SES_NOTIFICATION_CORRELATION_RETRY_TOPIC` (`@ruguin/event-schemas`).
- Produces: `CORRELATION_RETRY_BASE_BACKOFF_MS`/`CORRELATION_RETRY_MAX_ATTEMPTS`/`computeNextCorrelationRetryAt(attempt)`/`hasExhaustedCorrelationRetries(nextAttempt)` — reused by `ResolvePendingCorrelationUseCase` (Task 14). `IngestSesNotificationUseCase.execute({body}): Promise<Either<BaseError,{outcome: 'published'|'malformed-dlq'|'duplicate-skipped'|'lookup-pending'}>>` — consumed by `SesWebhookController` (Task 13).

- [ ] **Step 1: Write the failing test for the backoff helper**

`apps/ses-webhook-ingestor/src/ses-notification/application/__tests__/correlation-retry-backoff.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  computeNextCorrelationRetryAt,
  CORRELATION_RETRY_MAX_ATTEMPTS,
  hasExhaustedCorrelationRetries
} from '../correlation-retry-backoff.ts'

describe('correlation-retry-backoff', () => {
  it('computeNextCorrelationRetryAt returns a Date strictly in the future', () => {
    const now = Date.now()

    expect(computeNextCorrelationRetryAt(1).getTime()).toBeGreaterThan(now)
  })

  it('hasExhaustedCorrelationRetries is false at exactly the max attempts', () => {
    expect(hasExhaustedCorrelationRetries(CORRELATION_RETRY_MAX_ATTEMPTS)).toBe(false)
  })

  it('hasExhaustedCorrelationRetries is true one past the max attempts', () => {
    expect(hasExhaustedCorrelationRetries(CORRELATION_RETRY_MAX_ATTEMPTS + 1)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the backoff helper**

`apps/ses-webhook-ingestor/src/ses-notification/application/correlation-retry-backoff.ts`:

```ts
/*
 * The "not found" race is just Kafka consumer lag (dispatch-worker's sent event usually lands
 * within seconds) — not the multi-minute wait dispatch-worker's own SES-throttling backoff needs,
 * hence the much shorter base and lower ceiling here (~2s..~62s total across 5 attempts).
 */
export const CORRELATION_RETRY_BASE_BACKOFF_MS = 2000
export const CORRELATION_RETRY_MAX_ATTEMPTS = 5

export function computeNextCorrelationRetryAt(attempt: number): Date {
  const ceiling = CORRELATION_RETRY_BASE_BACKOFF_MS * 2 ** attempt
  // eslint-disable-next-line sonarjs/pseudo-random -- Retry-timing jitter, not security-sensitive.
  return new Date(Date.now() + ceiling / 2 + Math.random() * (ceiling / 2))
}

export function hasExhaustedCorrelationRetries(nextAttempt: number): boolean {
  return nextAttempt > CORRELATION_RETRY_MAX_ATTEMPTS
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: PASS

- [ ] **Step 5: Write the failing test for the use case**

`apps/ses-webhook-ingestor/src/ses-notification/application/use-cases/__tests__/ingest-ses-notification.use-case.unit.ts`:

```ts
import {
  EMAIL_STATUS_UPDATED_TOPIC,
  SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
  SES_NOTIFICATION_MALFORMED_DLQ_TOPIC
} from '@ruguin/event-schemas'
import { type MessageProducerPort } from '@ruguin/message-broker'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type CorrelationPort } from '../../providers/correlation.port.ts'
import { type DedupClaimPort } from '../../providers/dedup-claim.port.ts'
import { IngestSesNotificationUseCase } from '../ingest-ses-notification.use-case.ts'

const VALID_BODY = {
  id: 'evt-1',
  source: 'aws.ses',
  detail: { eventType: 'Delivery', mail: { messageId: 'ses-msg-1' } }
}

function buildUseCase(overrides: {
  dedupClaim?: Partial<DedupClaimPort>
  correlation?: Partial<CorrelationPort>
  producer?: Partial<MessageProducerPort>
}): IngestSesNotificationUseCase {
  const dedupClaim = {
    claim: vi.fn().mockResolvedValue(success({ claimed: true })),
    release: vi.fn().mockResolvedValue(success(undefined)),
    ...overrides.dedupClaim
  } as unknown as DedupClaimPort

  const correlation = {
    lookup: vi.fn().mockResolvedValue(success({ emailId: 'email-1' })),
    upsert: vi.fn(),
    ...overrides.correlation
  } as unknown as CorrelationPort

  const producer = {
    publish: vi.fn().mockResolvedValue(success(undefined)),
    ...overrides.producer
  } as unknown as MessageProducerPort

  return new IngestSesNotificationUseCase(dedupClaim, correlation, producer)
}

describe('IngestSesNotificationUseCase', () => {
  it('routes an invalid body to the malformed DLQ without touching dedup or correlation', async () => {
    const dedupClaim = { claim: vi.fn() } as unknown as DedupClaimPort
    const correlation = { lookup: vi.fn() } as unknown as CorrelationPort
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const useCase = new IngestSesNotificationUseCase(dedupClaim, correlation, { publish } as unknown as MessageProducerPort)

    const result = await useCase.execute({ body: { not: 'valid' } })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('malformed-dlq')
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ topic: SES_NOTIFICATION_MALFORMED_DLQ_TOPIC }))
    expect(dedupClaim.claim).not.toHaveBeenCalled()
    expect(correlation.lookup).not.toHaveBeenCalled()
  })

  it('skips a duplicate EventBridge delivery without looking up the correlation', async () => {
    const correlation = { lookup: vi.fn() } as unknown as CorrelationPort
    const useCase = buildUseCase({
      dedupClaim: { claim: vi.fn().mockResolvedValue(success({ claimed: false })) },
      correlation
    })

    const result = await useCase.execute({ body: VALID_BODY })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('duplicate-skipped')
    expect(correlation.lookup).not.toHaveBeenCalled()
  })

  it('propagates a dedup claim failure', async () => {
    const claimError = { name: 'CacheOperationError', message: 'redis down' }
    const useCase = buildUseCase({ dedupClaim: { claim: vi.fn().mockResolvedValue(failure(claimError)) } })

    const result = await useCase.execute({ body: VALID_BODY })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(claimError)
  })

  it('publishes email.status.updated when the correlation is found', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({ producer: { publish } })

    const result = await useCase.execute({ body: VALID_BODY })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('published')
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EMAIL_STATUS_UPDATED_TOPIC,
        key: 'email-1',
        message: expect.objectContaining({ payload: { emailId: 'email-1', status: 'delivered' } })
      })
    )
  })

  it('schedules a correlation retry when the correlation is not yet found', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({
      correlation: { lookup: vi.fn().mockResolvedValue(success(null)) },
      producer: { publish }
    })

    const result = await useCase.execute({ body: VALID_BODY })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('lookup-pending')
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
        key: 'ses-msg-1',
        headers: expect.objectContaining({ attempt: '1' }),
        message: expect.objectContaining({ payload: { sesMessageId: 'ses-msg-1', status: 'delivered' } })
      })
    )
  })

  it('releases the dedup claim and fails when the correlation lookup fails', async () => {
    const lookupError = { name: 'CorrelationLookupError', message: 'db down' }
    const release = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({
      dedupClaim: { release },
      correlation: { lookup: vi.fn().mockResolvedValue(failure(lookupError)) }
    })

    const result = await useCase.execute({ body: VALID_BODY })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(lookupError)
    expect(release).toHaveBeenCalledWith({ key: 'evt-1' })
  })

  it('releases the dedup claim and fails when publishing email.status.updated fails', async () => {
    const publishError = { name: 'MessagePublishError', message: 'kafka down' }
    const release = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({
      dedupClaim: { release },
      producer: { publish: vi.fn().mockResolvedValue(failure(publishError)) }
    })

    const result = await useCase.execute({ body: VALID_BODY })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(publishError)
    expect(release).toHaveBeenCalledWith({ key: 'evt-1' })
  })

  it('releases the dedup claim and fails when scheduling the correlation retry fails', async () => {
    const publishError = { name: 'MessagePublishError', message: 'kafka down' }
    const release = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({
      dedupClaim: { release },
      correlation: { lookup: vi.fn().mockResolvedValue(success(null)) },
      producer: { publish: vi.fn().mockResolvedValue(failure(publishError)) }
    })

    const result = await useCase.execute({ body: VALID_BODY })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(publishError)
    expect(release).toHaveBeenCalledWith({ key: 'evt-1' })
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: FAIL — `IngestSesNotificationUseCase` does not exist.

- [ ] **Step 7: Write the use case**

`apps/ses-webhook-ingestor/src/ses-notification/application/use-cases/ingest-ses-notification.use-case.ts`:

```ts
import { randomUUID } from 'node:crypto'

import { Inject, Injectable, Logger } from '@nestjs/common'
import { EMAIL_STATUS_UPDATED_TOPIC, SES_NOTIFICATION_CORRELATION_RETRY_TOPIC } from '@ruguin/event-schemas'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '@ruguin/message-broker'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { publishMalformedNotificationToDlq } from '../../consumers/dlq-routing.ts'
import { mapSesEventToStatus } from '../../domain/map-ses-event-to-status.ts'
import { EventBridgeSesNotificationSchema } from '../../presentation/dto/eventbridge-ses-notification.schema.ts'
import { computeNextCorrelationRetryAt } from '../correlation-retry-backoff.ts'
import { CORRELATION_PROVIDER, type CorrelationPort } from '../providers/correlation.port.ts'
import { DEDUP_CLAIM_PROVIDER, type DedupClaimPort } from '../providers/dedup-claim.port.ts'

/* 5 min — comfortably outlives a single EventBridge API Destination invocation's own retry window. */
const DEDUP_CLAIM_TTL_MS = 300_000

export type IngestSesNotificationInput = Readonly<{ body: unknown }>
export type IngestSesNotificationOutcome = 'published' | 'malformed-dlq' | 'duplicate-skipped' | 'lookup-pending'
export type IngestSesNotificationOutput = Readonly<{ outcome: IngestSesNotificationOutcome }>

@Injectable()
export class IngestSesNotificationUseCase {
  private readonly logger = new Logger(IngestSesNotificationUseCase.name)

  constructor(
    @Inject(DEDUP_CLAIM_PROVIDER) private readonly dedupClaim: DedupClaimPort,
    @Inject(CORRELATION_PROVIDER) private readonly correlation: CorrelationPort,
    @Inject(MESSAGE_PRODUCER_PORT) private readonly producer: MessageProducerPort
  ) {}

  public async execute(input: IngestSesNotificationInput): Promise<Either<BaseError, IngestSesNotificationOutput>> {
    const parsed = EventBridgeSesNotificationSchema.safeParse(input.body)
    if (!parsed.success) {
      this.logger.warn(`Malformed EventBridge SES notification: ${parsed.error.message}`)
      const published = await publishMalformedNotificationToDlq(this.producer, {
        rawBody: input.body,
        reason: parsed.error.message
      })
      if (published.isFailure()) return failure(published.value)
      return success({ outcome: 'malformed-dlq' })
    }

    const dedupKey = parsed.data.id
    const claimed = await this.dedupClaim.claim({ key: dedupKey, ttlInMs: DEDUP_CLAIM_TTL_MS })
    if (claimed.isFailure()) return failure(claimed.value)
    if (!claimed.value.claimed) return success({ outcome: 'duplicate-skipped' })

    const mapped = mapSesEventToStatus(parsed.data.detail)
    const sesMessageId = parsed.data.detail.mail.messageId

    const lookup = await this.correlation.lookup({ sesMessageId })
    if (lookup.isFailure()) {
      await this.releaseClaimAfterFailure(dedupKey)
      return failure(lookup.value)
    }

    if (lookup.value === null) {
      const scheduled = await this.schedulePendingCorrelation({ sesMessageId, ...mapped })
      if (scheduled.isFailure()) {
        await this.releaseClaimAfterFailure(dedupKey)
        return failure(scheduled.value)
      }
      return success({ outcome: 'lookup-pending' })
    }

    const published = await this.producer.publish({
      topic: EMAIL_STATUS_UPDATED_TOPIC,
      key: lookup.value.emailId,
      message: {
        eventId: randomUUID(),
        name: 'email.status.updated',
        payload: { emailId: lookup.value.emailId, ...mapped }
      }
    })
    if (published.isFailure()) {
      await this.releaseClaimAfterFailure(dedupKey)
      return failure(published.value)
    }

    return success({ outcome: 'published' })
  }

  private schedulePendingCorrelation(
    input: Readonly<{ sesMessageId: string; status: string; bounceType?: string }>
  ): Promise<Either<BaseError, void>> {
    const nextAttemptAt = computeNextCorrelationRetryAt(1)

    return this.producer.publish({
      topic: SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
      key: input.sesMessageId,
      message: { eventId: randomUUID(), name: 'ses.notification.correlation.pending', payload: input },
      headers: { attempt: '1', nextAttemptAt: nextAttemptAt.toISOString() }
    })
  }

  /*
   * Every failure this use case returns happens AFTER the dedup claim was taken — mirrors
   * apps/dispatch-worker's SendEmailUseCase: without releasing it, a legitimate EventBridge retry
   * of the same event id would be silently treated as a duplicate for the rest of the claim's TTL.
   */
  private async releaseClaimAfterFailure(key: string): Promise<void> {
    const released = await this.dedupClaim.release({ key })
    if (released.isFailure()) {
      this.logger.error(`Failed to release dedup claim ${key}: ${released.value.message}`)
    }
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/ses-webhook-ingestor/src/ses-notification/application
git commit -m "feat(ses-webhook-ingestor): add IngestSesNotificationUseCase"
```

---

## Task 13: `SesWebhookController` — wires the HTTP endpoint end to end

**Files:**
- Create: `apps/ses-webhook-ingestor/src/ses-notification/presentation/ses-webhook.controller.ts`
- Modify: `apps/ses-webhook-ingestor/src/ses-notification/ses-notification.module.ts`
- Test: `apps/ses-webhook-ingestor/src/ses-notification/presentation/__tests__/ses-webhook.controller.e2e.ts`

**Interfaces:**
- Consumes: `SesWebhookAuthGuard` (Task 10), `IngestSesNotificationUseCase` (Task 12), `DEDUP_CLAIM_PROVIDER`/`RedisDedupClaim` (Task 8).
- Produces: `POST /webhooks/ses` — `401` on a missing/wrong secret header; `200 { status: 'ok' }` on any accepted body (malformed, duplicate, published, or lookup-pending — all four are "handled" from EventBridge's perspective per the design's error-handling table); `500` only when a genuine Kafka publish failure happens inside the use case.

- [ ] **Step 1: Write the controller and wire the module**

`apps/ses-webhook-ingestor/src/ses-notification/presentation/ses-webhook.controller.ts`:

```ts
import { Body, Controller, HttpCode, InternalServerErrorException, Post, UseGuards } from '@nestjs/common'

import { IngestSesNotificationUseCase } from '../application/use-cases/ingest-ses-notification.use-case.ts'

import { SesWebhookAuthGuard } from './ses-webhook-auth.guard.ts'

@Controller('webhooks')
export class SesWebhookController {
  constructor(private readonly ingestSesNotification: IngestSesNotificationUseCase) {}

  @UseGuards(SesWebhookAuthGuard)
  @Post('ses')
  @HttpCode(200)
  public async handle(@Body() body: unknown): Promise<{ status: 'ok' }> {
    const result = await this.ingestSesNotification.execute({ body })
    /*
     * Every non-failure outcome from the use case (published, malformed-dlq, duplicate-skipped,
     * lookup-pending) means the notification was accepted and handled — 200 either way. Only a
     * genuine infra failure (a Kafka publish that didn't go through) is worth a 5xx, so
     * EventBridge's own retry policy gets a chance to redeliver it.
     */
    if (result.isFailure()) throw new InternalServerErrorException()

    return { status: 'ok' }
  }
}
```

`apps/ses-webhook-ingestor/src/ses-notification/ses-notification.module.ts` (full replacement):

```ts
import { Module } from '@nestjs/common'

import { CORRELATION_PROVIDER } from './application/providers/correlation.port.ts'
import { DEDUP_CLAIM_PROVIDER } from './application/providers/dedup-claim.port.ts'
import { IngestSesNotificationUseCase } from './application/use-cases/ingest-ses-notification.use-case.ts'
import { RecordSentCorrelationUseCase } from './application/use-cases/record-sent-correlation.use-case.ts'
import { EmailStatusUpdatedSentConsumer } from './consumers/email-status-updated-sent.consumer.ts'
import { PrismaCorrelationRepository } from './infra/postgres/prisma-correlation.repository.ts'
import { RedisDedupClaim } from './infra/redis/redis-dedup-claim.ts'
import { SesWebhookController } from './presentation/ses-webhook.controller.ts'

@Module({
  controllers: [SesWebhookController],
  providers: [
    { provide: CORRELATION_PROVIDER, useClass: PrismaCorrelationRepository },
    { provide: DEDUP_CLAIM_PROVIDER, useClass: RedisDedupClaim },
    RecordSentCorrelationUseCase,
    IngestSesNotificationUseCase,
    EmailStatusUpdatedSentConsumer
  ]
})
export class SesNotificationModule {}
```

- [ ] **Step 2: Write the failing e2e test**

`apps/ses-webhook-ingestor/src/ses-notification/presentation/__tests__/ses-webhook.controller.e2e.ts`:

```ts
import { type INestApplication } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../../app.module.ts'
import { SES_INGESTOR_SECRET_HEADER } from '../ses-webhook-auth.guard.ts'

const SHARED_SECRET = 'e2e-shared-secret'

vi.hoisted(() => {
  process.env.CACHE_PREFIX = 'ruguin:e2e-webhook'
  process.env.CACHE_DRIVER = 'memory'
  process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin'
  process.env.SES_WEBHOOK_INGESTOR_SHARED_SECRET = 'e2e-shared-secret'
})

describe('POST /webhooks/ses', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()

    app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.init()
    await (app as unknown as NestFastifyApplication).getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 401 when the secret header is missing', async () => {
    const response = await (app as unknown as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'POST', url: '/webhooks/ses', payload: {} })

    expect(response.statusCode).toBe(401)
  })

  it('returns 401 when the secret header is wrong', async () => {
    const response = await (app as unknown as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/webhooks/ses',
        headers: { [SES_INGESTOR_SECRET_HEADER]: 'wrong-secret' },
        payload: {}
      })

    expect(response.statusCode).toBe(401)
  })

  it('returns 200 for a malformed body once authenticated', async () => {
    const response = await (app as unknown as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/webhooks/ses',
        headers: { [SES_INGESTOR_SECRET_HEADER]: SHARED_SECRET },
        payload: { not: 'valid' }
      })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toEqual({ status: 'ok' })
  })

  it('returns 200 for a well-formed notification with no correlation yet', async () => {
    const response = await (app as unknown as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/webhooks/ses',
        headers: { [SES_INGESTOR_SECRET_HEADER]: SHARED_SECRET },
        payload: {
          id: 'evt-e2e-1',
          source: 'aws.ses',
          detail: { eventType: 'Delivery', mail: { messageId: `int-test-e2e-${Date.now()}` } }
        }
      })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toEqual({ status: 'ok' })
  })
})
```

- [ ] **Step 3: Run test to verify it fails, then passes**

Run: `docker compose -f infrastructure/local/docker-compose.yml up -d kafka postgres && pnpm --filter @ruguin/ses-webhook-ingestor build && pnpm --filter @ruguin/ses-webhook-ingestor test:e2e`
Expected first: FAIL — `SesWebhookController` does not exist / route not found. After Step 1: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/ses-webhook-ingestor/src/ses-notification
git commit -m "feat(ses-webhook-ingestor): add POST /webhooks/ses controller"
```

---

## Task 14: `ResolvePendingCorrelationUseCase` + the correlation retry consumer

**Files:**
- Create: `apps/ses-webhook-ingestor/src/ses-notification/application/use-cases/resolve-pending-correlation.use-case.ts`
- Test: `apps/ses-webhook-ingestor/src/ses-notification/application/use-cases/__tests__/resolve-pending-correlation.use-case.unit.ts`
- Create: `apps/ses-webhook-ingestor/src/ses-notification/consumers/ses-notification-correlation-retry.consumer.ts`
- Modify: `apps/ses-webhook-ingestor/src/ses-notification/ses-notification.module.ts`
- Test: `apps/ses-webhook-ingestor/src/ses-notification/consumers/__tests__/ses-notification-correlation-retry.consumer.int.ts`

**Interfaces:**
- Consumes: `CorrelationPort` (Task 7), `computeNextCorrelationRetryAt`/`hasExhaustedCorrelationRetries` (Task 12), `publishExhaustedCorrelationToDlq`/`publishMalformedNotificationToDlq` (Task 11), `SesNotificationCorrelationPendingPayloadSchema`/`SES_NOTIFICATION_CORRELATION_RETRY_TOPIC` (Task 2).
- Produces: `ResolvePendingCorrelationUseCase.execute({sesMessageId, status, bounceType?, attempt}): Promise<Either<BaseError,{outcome: 'published'|'retry-scheduled'|'exhausted'}>>`, `SesNotificationCorrelationRetryConsumer` (Kafka consumer, group id `ses-webhook-ingestor-retry`). Closes the loop the design's "C. Resolvendo o retry" section describes.

- [ ] **Step 1: Write the failing test for the use case**

`apps/ses-webhook-ingestor/src/ses-notification/application/use-cases/__tests__/resolve-pending-correlation.use-case.unit.ts`:

```ts
import { EMAIL_STATUS_UPDATED_TOPIC, SES_NOTIFICATION_CORRELATION_RETRY_TOPIC } from '@ruguin/event-schemas'
import { type MessageProducerPort } from '@ruguin/message-broker'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { CORRELATION_RETRY_MAX_ATTEMPTS } from '../../correlation-retry-backoff.ts'
import { type CorrelationPort } from '../../providers/correlation.port.ts'
import { ResolvePendingCorrelationUseCase } from '../resolve-pending-correlation.use-case.ts'

function buildUseCase(overrides: {
  correlation?: Partial<CorrelationPort>
  producer?: Partial<MessageProducerPort>
}): ResolvePendingCorrelationUseCase {
  const correlation = {
    lookup: vi.fn().mockResolvedValue(success(null)),
    upsert: vi.fn(),
    ...overrides.correlation
  } as unknown as CorrelationPort

  const producer = {
    publish: vi.fn().mockResolvedValue(success(undefined)),
    ...overrides.producer
  } as unknown as MessageProducerPort

  return new ResolvePendingCorrelationUseCase(correlation, producer)
}

describe('ResolvePendingCorrelationUseCase', () => {
  it('publishes email.status.updated when the correlation now exists', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({
      correlation: { lookup: vi.fn().mockResolvedValue(success({ emailId: 'email-1' })) },
      producer: { publish }
    })

    const result = await useCase.execute({
      sesMessageId: 'ses-msg-1',
      status: 'bounced',
      bounceType: 'Permanent',
      attempt: 1
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('published')
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EMAIL_STATUS_UPDATED_TOPIC,
        key: 'email-1',
        message: expect.objectContaining({ payload: { emailId: 'email-1', status: 'bounced', bounceType: 'Permanent' } })
      })
    )
  })

  it('propagates a correlation lookup failure', async () => {
    const lookupError = { name: 'CorrelationLookupError', message: 'db down' }
    const useCase = buildUseCase({ correlation: { lookup: vi.fn().mockResolvedValue(failure(lookupError)) } })

    const result = await useCase.execute({ sesMessageId: 'ses-msg-1', status: 'delivered', attempt: 1 })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(lookupError)
  })

  it('reschedules the retry when the correlation is still missing and attempts remain', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({ producer: { publish } })

    const result = await useCase.execute({ sesMessageId: 'ses-msg-1', status: 'delivered', attempt: 1 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('retry-scheduled')
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: SES_NOTIFICATION_CORRELATION_RETRY_TOPIC, key: 'ses-msg-1', headers: { attempt: '2', nextAttemptAt: expect.any(String) } })
    )
  })

  it('routes to the DLQ once retries are exhausted', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({ producer: { publish } })

    const result = await useCase.execute({
      sesMessageId: 'ses-msg-1',
      status: 'delivered',
      attempt: CORRELATION_RETRY_MAX_ATTEMPTS
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('exhausted')
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { attempt: String(CORRELATION_RETRY_MAX_ATTEMPTS + 1) } })
    )
  })

  it('fails when publishing email.status.updated fails', async () => {
    const publishError = { name: 'MessagePublishError', message: 'kafka down' }
    const useCase = buildUseCase({
      correlation: { lookup: vi.fn().mockResolvedValue(success({ emailId: 'email-1' })) },
      producer: { publish: vi.fn().mockResolvedValue(failure(publishError)) }
    })

    const result = await useCase.execute({ sesMessageId: 'ses-msg-1', status: 'delivered', attempt: 1 })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(publishError)
  })

  it('fails when rescheduling the retry fails', async () => {
    const publishError = { name: 'MessagePublishError', message: 'kafka down' }
    const useCase = buildUseCase({ producer: { publish: vi.fn().mockResolvedValue(failure(publishError)) } })

    const result = await useCase.execute({ sesMessageId: 'ses-msg-1', status: 'delivered', attempt: 1 })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(publishError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: FAIL — `ResolvePendingCorrelationUseCase` does not exist.

- [ ] **Step 3: Write the use case**

`apps/ses-webhook-ingestor/src/ses-notification/application/use-cases/resolve-pending-correlation.use-case.ts`:

```ts
import { randomUUID } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'
import { EMAIL_STATUS_UPDATED_TOPIC, SES_NOTIFICATION_CORRELATION_RETRY_TOPIC } from '@ruguin/event-schemas'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '@ruguin/message-broker'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { publishExhaustedCorrelationToDlq } from '../../consumers/dlq-routing.ts'
import { computeNextCorrelationRetryAt, hasExhaustedCorrelationRetries } from '../correlation-retry-backoff.ts'
import { CORRELATION_PROVIDER, type CorrelationPort } from '../providers/correlation.port.ts'

export type ResolvePendingCorrelationInput = Readonly<{
  sesMessageId: string
  status: string
  bounceType?: string
  attempt: number
}>

export type ResolvePendingCorrelationOutcome = 'published' | 'retry-scheduled' | 'exhausted'
export type ResolvePendingCorrelationOutput = Readonly<{ outcome: ResolvePendingCorrelationOutcome }>

@Injectable()
export class ResolvePendingCorrelationUseCase {
  constructor(
    @Inject(CORRELATION_PROVIDER) private readonly correlation: CorrelationPort,
    @Inject(MESSAGE_PRODUCER_PORT) private readonly producer: MessageProducerPort
  ) {}

  public async execute(input: ResolvePendingCorrelationInput): Promise<Either<BaseError, ResolvePendingCorrelationOutput>> {
    const lookup = await this.correlation.lookup({ sesMessageId: input.sesMessageId })
    if (lookup.isFailure()) return failure(lookup.value)

    if (lookup.value !== null) {
      const published = await this.producer.publish({
        topic: EMAIL_STATUS_UPDATED_TOPIC,
        key: lookup.value.emailId,
        message: {
          eventId: randomUUID(),
          name: 'email.status.updated',
          payload: {
            emailId: lookup.value.emailId,
            status: input.status,
            ...(input.bounceType !== undefined && { bounceType: input.bounceType })
          }
        }
      })
      if (published.isFailure()) return failure(published.value)

      return success({ outcome: 'published' })
    }

    const nextAttempt = input.attempt + 1

    if (hasExhaustedCorrelationRetries(nextAttempt)) {
      const dlq = await publishExhaustedCorrelationToDlq(this.producer, {
        sesMessageId: input.sesMessageId,
        status: input.status,
        attempt: nextAttempt,
        ...(input.bounceType !== undefined && { bounceType: input.bounceType })
      })
      if (dlq.isFailure()) return failure(dlq.value)

      return success({ outcome: 'exhausted' })
    }

    const nextAttemptAt = computeNextCorrelationRetryAt(nextAttempt)
    const rescheduled = await this.producer.publish({
      topic: SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
      key: input.sesMessageId,
      message: {
        eventId: randomUUID(),
        name: 'ses.notification.correlation.pending',
        payload: {
          sesMessageId: input.sesMessageId,
          status: input.status,
          ...(input.bounceType !== undefined && { bounceType: input.bounceType })
        }
      },
      headers: { attempt: String(nextAttempt), nextAttemptAt: nextAttemptAt.toISOString() }
    })
    if (rescheduled.isFailure()) return failure(rescheduled.value)

    return success({ outcome: 'retry-scheduled' })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor test`
Expected: PASS

- [ ] **Step 5: Write the retry consumer and wire it into the module**

`apps/ses-webhook-ingestor/src/ses-notification/consumers/ses-notification-correlation-retry.consumer.ts`:

```ts
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { SES_NOTIFICATION_CORRELATION_RETRY_TOPIC, SesNotificationCorrelationPendingPayloadSchema } from '@ruguin/event-schemas'
import {
  MESSAGE_CONSUMER_PORT,
  MESSAGE_PRODUCER_PORT,
  type MessageConsumerPort,
  type MessageProducerPort
} from '@ruguin/message-broker'
import { failure, success } from '@ruguin/utils'

import { ResolvePendingCorrelationUseCase } from '../application/use-cases/resolve-pending-correlation.use-case.ts'

import { publishMalformedNotificationToDlq } from './dlq-routing.ts'

export const CORRELATION_RETRY_CONSUMER_GROUP_ID = 'ses-webhook-ingestor-retry'

function waitUntil(dueAt: Date): Promise<void> {
  const waitMs = Math.max(0, dueAt.getTime() - Date.now())
  return new Promise((resolve) => setTimeout(resolve, waitMs))
}

@Injectable()
export class SesNotificationCorrelationRetryConsumer implements OnModuleInit {
  private readonly logger = new Logger(SesNotificationCorrelationRetryConsumer.name)

  constructor(
    @Inject(MESSAGE_CONSUMER_PORT) private readonly consumer: MessageConsumerPort,
    @Inject(MESSAGE_PRODUCER_PORT) private readonly producer: MessageProducerPort,
    private readonly resolvePendingCorrelation: ResolvePendingCorrelationUseCase
  ) {}

  public async onModuleInit(): Promise<void> {
    await this.consumer.subscribe({
      topic: SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
      groupId: CORRELATION_RETRY_CONSUMER_GROUP_ID,
      onMessage: async (message) => {
        const parsed = SesNotificationCorrelationPendingPayloadSchema.safeParse(message.payload)
        if (!parsed.success) {
          this.logger.warn(`Malformed correlation-retry payload (eventId=${message.eventId}); routing to DLQ.`)
          return publishMalformedNotificationToDlq(this.producer, { rawBody: message.payload, reason: parsed.error.message })
        }

        const attempt = Number(message.headers.attempt ?? '0')
        const nextAttemptAt = new Date(message.headers.nextAttemptAt ?? new Date().toISOString())

        /*
         * Same defensive check as apps/dispatch-worker's retry consumer: a producer bug or
         * hand-crafted message could carry a non-numeric attempt or unparseable nextAttemptAt.
         */
        if (!Number.isSafeInteger(attempt) || Number.isNaN(nextAttemptAt.getTime())) {
          this.logger.warn(
            `Malformed correlation-retry headers for eventId=${message.eventId} ` +
              `(attempt=${message.headers.attempt}, nextAttemptAt=${message.headers.nextAttemptAt}); routing to DLQ.`
          )
          return publishMalformedNotificationToDlq(this.producer, {
            rawBody: message.payload,
            reason: 'invalid attempt/nextAttemptAt headers'
          })
        }

        await waitUntil(nextAttemptAt)

        const result = await this.resolvePendingCorrelation.execute({ ...parsed.data, attempt })
        if (result.isFailure()) return failure(result.value)

        return success(undefined)
      }
    })
  }
}
```

`apps/ses-webhook-ingestor/src/ses-notification/ses-notification.module.ts` (full replacement — adds the use case and consumer):

```ts
import { Module } from '@nestjs/common'

import { CORRELATION_PROVIDER } from './application/providers/correlation.port.ts'
import { DEDUP_CLAIM_PROVIDER } from './application/providers/dedup-claim.port.ts'
import { IngestSesNotificationUseCase } from './application/use-cases/ingest-ses-notification.use-case.ts'
import { RecordSentCorrelationUseCase } from './application/use-cases/record-sent-correlation.use-case.ts'
import { ResolvePendingCorrelationUseCase } from './application/use-cases/resolve-pending-correlation.use-case.ts'
import { EmailStatusUpdatedSentConsumer } from './consumers/email-status-updated-sent.consumer.ts'
import { SesNotificationCorrelationRetryConsumer } from './consumers/ses-notification-correlation-retry.consumer.ts'
import { PrismaCorrelationRepository } from './infra/postgres/prisma-correlation.repository.ts'
import { RedisDedupClaim } from './infra/redis/redis-dedup-claim.ts'
import { SesWebhookController } from './presentation/ses-webhook.controller.ts'

@Module({
  controllers: [SesWebhookController],
  providers: [
    { provide: CORRELATION_PROVIDER, useClass: PrismaCorrelationRepository },
    { provide: DEDUP_CLAIM_PROVIDER, useClass: RedisDedupClaim },
    RecordSentCorrelationUseCase,
    IngestSesNotificationUseCase,
    ResolvePendingCorrelationUseCase,
    EmailStatusUpdatedSentConsumer,
    SesNotificationCorrelationRetryConsumer
  ]
})
export class SesNotificationModule {}
```

- [ ] **Step 6: Write the failing integration test**

`apps/ses-webhook-ingestor/src/ses-notification/consumers/__tests__/ses-notification-correlation-retry.consumer.int.ts`:

```ts
import { randomUUID } from 'node:crypto'

import { Test, type TestingModule } from '@nestjs/testing'
import { EMAIL_STATUS_UPDATED_TOPIC, SES_NOTIFICATION_CORRELATION_RETRY_TOPIC } from '@ruguin/event-schemas'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '@ruguin/message-broker'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../../app.module.ts'
import { createTestPrismaService } from '../../../shared/infrastructure/database/prisma/__tests__/database-test-context.ts'
import { type PrismaService } from '../../../shared/infrastructure/database/prisma/prisma.service.ts'

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin'
})

const isStatusUpdated = ([call]: Parameters<MessageProducerPort['publish']>): boolean => call.topic === EMAIL_STATUS_UPDATED_TOPIC

describe('SesNotificationCorrelationRetryConsumer (real Kafka + Postgres)', () => {
  let moduleReference: TestingModule
  let prisma: PrismaService

  beforeAll(() => {
    prisma = createTestPrismaService()
  })

  afterEach(async () => {
    await moduleReference.close()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('resolves once the correlation exists and publishes email.status.updated', async () => {
    moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()
    await moduleReference.init()

    const emailId = randomUUID()
    const sesMessageId = `int-test-retry-${randomUUID()}`
    await prisma.sesMessageCorrelation.create({ data: { sesMessageId, emailId } })

    const producer = moduleReference.get<MessageProducerPort>(MESSAGE_PRODUCER_PORT)
    const publishSpy = vi.spyOn(producer, 'publish')

    await producer.publish({
      topic: SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
      key: sesMessageId,
      message: {
        eventId: 'evt-retry-1',
        name: 'ses.notification.correlation.pending',
        payload: { sesMessageId, status: 'delivered' }
      },
      headers: { attempt: '1', nextAttemptAt: new Date().toISOString() }
    })

    await vi.waitUntil(() => publishSpy.mock.calls.some((call) => isStatusUpdated(call)), {
      timeout: 15_000,
      interval: 200
    })

    const callIndex = publishSpy.mock.calls.findIndex((call) => isStatusUpdated(call))
    const [statusUpdatedCall] = publishSpy.mock.calls[callIndex]!
    expect(statusUpdatedCall.message.payload).toMatchObject({ emailId, status: 'delivered' })

    await prisma.sesMessageCorrelation.delete({ where: { sesMessageId } })
  }, 20_000)
})
```

- [ ] **Step 7: Run test to verify it fails, then passes**

Run: `docker compose -f infrastructure/local/docker-compose.yml up -d kafka postgres && pnpm --filter @ruguin/ses-webhook-ingestor build && pnpm --filter @ruguin/ses-webhook-ingestor test:integration`
Expected first: FAIL — `SesNotificationCorrelationRetryConsumer` does not exist. After Steps 3–5: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/ses-webhook-ingestor/src/ses-notification
git commit -m "feat(ses-webhook-ingestor): resolve pending correlations via a retry consumer"
```

---

## Task 15: Full pipeline e2e test

**Files:**
- Test: `apps/ses-webhook-ingestor/src/__tests__/ses-webhook-ingestor-pipeline.e2e.ts`

**Interfaces:**
- Consumes: `AppModule` (all prior tasks) — this test boots the whole app against real Kafka/Postgres/Redis and exercises no mocks.
- Produces: nothing new — this is the design doc's own "Estratégia de testes" E2E scenario made concrete: sent → correlation recorded → webhook POSTed → `email.status.updated` republished with the right status and `bounceType`.

- [ ] **Step 1: Write the test**

`apps/ses-webhook-ingestor/src/__tests__/ses-webhook-ingestor-pipeline.e2e.ts`:

```ts
import { randomUUID } from 'node:crypto'

import { type INestApplication } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test, type TestingModule } from '@nestjs/testing'
import { EMAIL_STATUS_UPDATED_TOPIC } from '@ruguin/event-schemas'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort, type OutboundMessage } from '@ruguin/message-broker'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../app.module.ts'
import { createTestPrismaService } from '../shared/infrastructure/database/prisma/__tests__/database-test-context.ts'
import { type PrismaService } from '../shared/infrastructure/database/prisma/prisma.service.ts'
import { SES_INGESTOR_SECRET_HEADER } from '../ses-notification/presentation/ses-webhook-auth.guard.ts'

const SHARED_SECRET = 'pipeline-e2e-secret'

vi.hoisted(() => {
  process.env.CACHE_PREFIX = 'ruguin:e2e-pipeline'
  process.env.CACHE_DRIVER = 'memory'
  process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin'
  process.env.SES_WEBHOOK_INGESTOR_SHARED_SECRET = 'pipeline-e2e-secret'
})

function findBouncedPublish(calls: [OutboundMessage][]): OutboundMessage | undefined {
  const found = calls.find(
    ([call]) =>
      call.topic === EMAIL_STATUS_UPDATED_TOPIC &&
      (call.message.payload as { status?: string }).status === 'bounced'
  )
  return found?.[0]
}

describe('SES webhook ingestor — full pipeline', () => {
  let app: INestApplication
  let moduleReference: TestingModule
  let testPrisma: PrismaService

  beforeAll(async () => {
    testPrisma = createTestPrismaService()
    moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()

    app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.init()
    await (app as unknown as NestFastifyApplication).getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
    await testPrisma.$disconnect()
  })

  it('correlates a sent email to a bounce notification and republishes email.status.updated', async () => {
    const producer = moduleReference.get<MessageProducerPort>(MESSAGE_PRODUCER_PORT)
    const publishSpy = vi.spyOn(producer, 'publish')

    const emailId = randomUUID()
    const sesMessageId = `pipeline-e2e-${randomUUID()}`

    // Step 1: simulate dispatch-worker's own "sent" event.
    await producer.publish({
      topic: EMAIL_STATUS_UPDATED_TOPIC,
      key: emailId,
      message: {
        eventId: 'evt-pipeline-sent',
        name: 'email.status.updated',
        payload: { emailId, status: 'sent', sesMessageId }
      }
    })

    // Step 2: wait for the correlation consumer (Task 9) to record the row in Postgres — polling
    // the actual side effect, not a fixed sleep, so this can't flake under a slow CI runner.
    await vi.waitUntil(
      async () => (await testPrisma.sesMessageCorrelation.findUnique({ where: { sesMessageId } })) !== null,
      { timeout: 15_000, interval: 200 }
    )

    // Step 3: POST the EventBridge-shaped SES bounce notification.
    const response = await (app as unknown as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/webhooks/ses',
        headers: { [SES_INGESTOR_SECRET_HEADER]: SHARED_SECRET },
        payload: {
          id: `evt-pipeline-bounce-${randomUUID()}`,
          source: 'aws.ses',
          detail: { eventType: 'Bounce', mail: { messageId: sesMessageId }, bounce: { bounceType: 'Permanent' } }
        }
      })

    expect(response.statusCode).toBe(200)

    // Step 4: confirm email.status.updated carries the right emailId/status/bounceType — this
    // passes whether the lookup found the row immediately or fell back to the retry topic
    // (Task 14), since both paths publish the same event.
    await vi.waitUntil(() => findBouncedPublish(publishSpy.mock.calls as [OutboundMessage][]) !== undefined, {
      timeout: 20_000,
      interval: 200
    })

    const bouncedMessage = findBouncedPublish(publishSpy.mock.calls as [OutboundMessage][])
    expect(bouncedMessage?.message.payload).toMatchObject({ emailId, status: 'bounced', bounceType: 'Permanent' })

    await testPrisma.sesMessageCorrelation.delete({ where: { sesMessageId } })
  }, 40_000)
})
```

- [ ] **Step 2: Run the test**

Run: `docker compose -f infrastructure/local/docker-compose.yml up -d kafka postgres redis && pnpm --filter @ruguin/ses-webhook-ingestor build && pnpm --filter @ruguin/ses-webhook-ingestor test:e2e`
Expected: PASS — every prior task's piece (Tasks 6–14) already exists, so this test should pass on the first run; it exists to prove the *whole* pipeline works together, not any single piece.

- [ ] **Step 3: Run the full app test suite one more time to confirm nothing regressed**

Run: `pnpm --filter @ruguin/ses-webhook-ingestor build && pnpm --filter @ruguin/ses-webhook-ingestor test:all`
Expected: every unit, integration, and e2e test in the app passes.

- [ ] **Step 4: Commit**

```bash
git add apps/ses-webhook-ingestor/src/__tests__
git commit -m "test(ses-webhook-ingestor): add full pipeline e2e test"
```

---

## Task 16: Correct the pre-existing docs (SNS → EventBridge, Kafka consumption)

**Files:**
- Modify: `docs/product-spec.md`
- Modify: `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md`

**Interfaces:**
- Consumes: nothing — pure documentation correction, no code interface.
- Produces: both docs describe the transport (EventBridge, not SNS), the auth mechanism (shared secret, not SNS signature), and the fact that this service consumes `email.status.updated` (not "—"), matching `docs/superpowers/specs/2026-08-04-ses-webhook-ingestor-design.md` and Tasks 1–15's actual implementation.

- [ ] **Step 1: Correct `docs/product-spec.md`'s services table (§2)**

Find:

```
| **SES Webhook Ingestor** | Recebe notificações SNS da AWS (delivery/bounce/complaint) via HTTP, normaliza o payload                                  | [Planejado]                                                             |
```

Replace with:

```
| **SES Webhook Ingestor** | Recebe notificações da SES via Amazon EventBridge (delivery/bounce/complaint), normaliza o payload, mantém a correlação `sesMessageId → emailId` | [Planejado]                                                             |
```

- [ ] **Step 2: Correct §3.4 "Recepção de status de entrega"**

Find:

```
### 3.4 Recepção de status de entrega — [Planejado]

- Endpoint HTTP que recebe notificações SNS da AWS (delivered, bounce, complaint).
- Normaliza o payload da SNS e publica `email.status.updated` com o status correspondente.
- Base para a regra de supressão automática de endereços (ver NFR de confiabilidade).
```

Replace with:

```
### 3.4 Recepção de status de entrega — [Planejado]

- Endpoint HTTP que recebe notificações da SES via Amazon EventBridge (delivered, bounce, complaint) — não SNS; ver `docs/superpowers/specs/2026-08-04-ses-webhook-ingestor-design.md`.
- Mantém uma tabela de correlação `sesMessageId → emailId`, populada a partir de `email.status.updated` (`status=sent`) — a notificação da SES só carrega o `sesMessageId`, nunca o `emailId` interno.
- Normaliza o payload e publica `email.status.updated` com o status correspondente (`delivered`/`bounced`/`complained`, com `bounceType` quando aplicável).
- Base para a regra de supressão automática de endereços (ver NFR de confiabilidade).
```

- [ ] **Step 3: Correct the `/webhooks/ses` row in §6 "Endpoints necessários"**

Find:

```
| `POST`                         | `/webhooks/ses`                | SES Webhook Ingestor | Assinatura SNS (verificação de origem AWS) | Notificação SNS (delivery/bounce/complaint)                                                         | `200` (ack)                                                                                                                                              | [Planejado]                                                          |
```

Replace with:

```
| `POST`                         | `/webhooks/ses`                | SES Webhook Ingestor | Segredo compartilhado (header, via EventBridge API Destination) | Notificação da SES via EventBridge (delivery/bounce/complaint)                                                         | `200` (ack)                                                                                                                                              | [Planejado]                                                          |
```

- [ ] **Step 4: Correct the services table in `docs/superpowers/specs/2026-07-28-transactional-email-api-design.md`**

Find:

```
| **SES Webhook Ingestor** | Recebe notificações SNS da AWS (delivery/bounce/complaint) via HTTP, normaliza o payload | HTTP (SNS) | `email.status.updated` |
```

Replace with:

```
| **SES Webhook Ingestor** | Recebe notificações da SES via EventBridge (delivery/bounce/complaint), normaliza o payload | HTTP (EventBridge) + `email.status.updated` (correlação) | `email.status.updated` |
```

- [ ] **Step 5: Correct step 3 of "Fluxo de dados: enviar um email"**

Find:

```
3. **AWS SES** processa a entrega e notifica de forma assíncrona via SNS (delivered/bounce/complaint) → o **SES Webhook Ingestor** recebe via HTTP, normaliza, e publica em `email.status.updated`.
```

Replace with:

```
3. **AWS SES** processa a entrega e notifica de forma assíncrona via Amazon EventBridge (delivered/bounce/complaint) → o **SES Webhook Ingestor** recebe via HTTP (API Destination), correlaciona ao `emailId` interno via uma tabela própria alimentada por `email.status.updated` (`status=sent`), normaliza, e publica em `email.status.updated`. Detalhes: `docs/superpowers/specs/2026-08-04-ses-webhook-ingestor-design.md`.
```

- [ ] **Step 6: Commit**

```bash
git add docs/product-spec.md docs/superpowers/specs/2026-07-28-transactional-email-api-design.md
git commit -m "docs: correct SES Webhook Ingestor transport (SNS -> EventBridge) and Kafka consumption"
```

---

## Final verification

- [ ] Run the whole app's suite one last time: `pnpm --filter @ruguin/ses-webhook-ingestor build && pnpm --filter @ruguin/ses-webhook-ingestor check:types && pnpm --filter @ruguin/ses-webhook-ingestor check:lint && pnpm --filter @ruguin/ses-webhook-ingestor test:all`
- [ ] Run the full monorepo build/check from root to confirm nothing else broke: `pnpm build && pnpm check`
- [ ] Confirm `docs/superpowers/specs/2026-08-04-ses-webhook-ingestor-design.md`'s "Decisões em aberto" list still accurately reflects what's deferred (AWS-side provisioning, correlation table retention) — nothing in this plan resolves those, by design.

