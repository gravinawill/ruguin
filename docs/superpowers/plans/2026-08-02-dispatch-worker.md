# Dispatch Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the core send path — consume `email.send.requested`, send via SES/LocalStack under a shared Redis rate limit, and retry transient failures through a dedicated Kafka retry topic before falling back to the DLQ.

**Architecture:** Three new pnpm workspace packages/apps, built bottom-up: `packages/event-schemas` (Zod contracts + topic constants), `packages/message-broker` (KafkaJS producer/consumer adapters + NestJS module, replacing `apps/core-server`'s local fake), and `apps/dispatch-worker` (NestJS, no HTTP routes except `GET /health`, no Postgres schema — all state in Redis via `@ruguin/cache`).

**Tech Stack:** TypeScript 6.0.3 (ESM, explicit `.ts` import extensions), NestJS ^11.1.28 family, KafkaJS (new dependency), `@aws-sdk/client-ses` (new dependency), Zod 4.4.3, Vitest 4.x (`.unit.ts`/`.int.ts`/`.e2e.ts` projects), pnpm workspaces + Turborepo.

**Reference spec:** `docs/superpowers/specs/2026-08-02-dispatch-worker-design.md`

## Global Constraints

- Package manager is pnpm (`workspace:*` protocol for internal deps) — never npm/yarn.
- ESM only, relative imports use explicit `.ts` extensions (`moduleResolution: NodeNext` convention already used by every package in this repo).
- Every function that returns `Either<...>` (from `@ruguin/utils`) must explicitly annotate its return type — `success(x)` alone infers `Either<unknown, X>` and breaks failure-branch narrowing (`packages/utils/CLAUDE.md`).
- `apps/dispatch-worker` owns no Postgres schema — rate limiting, idempotency, and retry timing all live in Redis via `@ruguin/cache`.
- Kafka topic names are never hardcoded outside `packages/event-schemas` — every producer/consumer imports the topic constant.
- Backoff formula: `nextAttemptAt = Date.now() + BASE_BACKOFF_MS * 2 ** attempts`, no jitter — same shape as `computeNextAttemptAt` in `apps/core-server`'s `outbox-relay.service.ts`, with `BASE_BACKOFF_MS = 5000` so 3 retries land at ~10s / ~20s / ~40s.
- Idempotency claim key is `${emailId}:${attempt}`, not just `emailId` — a bare `emailId` key would make the *first* claim block every legitimate retry of the same email.
- **Prerequisite:** `MessageProducerPort`, `FakeMessageProducer`, and the `eventId`/`module`/`name`/`nextAttemptAt` version of `apps/core-server/prisma/schema/outbox.prisma` currently exist only in the sibling worktree `core-server-outbox-design`, not on `develop`. Task 4 below creates the (extended) port fresh in `packages/message-broker` regardless of whether that worktree has merged yet, and Task 9 adapts `apps/core-server` defensively — see that task's note.

---

## Part 1 — `packages/event-schemas`

### Task 1: Scaffold the package + `email.send.requested` contract

**Files:**

- Create: `packages/event-schemas/package.json`
- Create: `packages/event-schemas/tsconfig.json`
- Create: `packages/event-schemas/eslint.config.ts`
- Create: `packages/event-schemas/vitest.config.ts`
- Create: `packages/event-schemas/src/message-envelope.schema.ts`
- Create: `packages/event-schemas/src/email-send-requested.schema.ts`
- Create: `packages/event-schemas/src/index.ts`
- Test: `packages/event-schemas/src/__tests__/email-send-requested.schema.unit.ts`

**Interfaces:**

- Produces: `createMessageEnvelopeSchema<T>(payloadSchema: T)`, `EmailSendRequestedPayloadSchema`, `type EmailSendRequestedPayload`, `EMAIL_SEND_REQUESTED_TOPIC`, `EMAIL_SEND_REQUESTED_RETRY_TOPIC`, `EMAIL_SEND_REQUESTED_DLQ_TOPIC` — consumed by every later task that publishes/consumes this event.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@ruguin/event-schemas",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "check:lint": "eslint . --max-warnings 0",
    "check:types": "tsc --noEmit --pretty",
    "clean": "rm -rf .claude-flow .swarm .superpowers .remember .gitnexus .turbo coverage node_modules dist build",
    "fix:lint": "eslint --fix .",
    "test:all": "vitest run",
    "test:unit": "vitest run",
    "update:deps": "ncu -u"
  },
  "lint-staged": {
    "*.ts": "eslint --fix"
  },
  "dependencies": {
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@ruguin/eslint-config": "workspace:*",
    "@ruguin/typescript-config": "workspace:*",
    "@types/node": "^26.1.2",
    "npm-check-updates": "23.0.0",
    "typescript": "6.0.3",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ruguin/typescript-config/base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts", "vitest.config.ts", "eslint.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `eslint.config.ts`**

```ts
import { defineConfig } from '@ruguin/eslint-config'

export default defineConfig({})
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.unit.ts'],
    clearMocks: true,
    restoreMocks: true,
    reporters: ['verbose'],
    testTimeout: 5000,
    passWithNoTests: true
  }
})
```

- [ ] **Step 5: Write the failing test for the envelope + send-requested schema**

```ts
// packages/event-schemas/src/__tests__/email-send-requested.schema.unit.ts
import { describe, expect, it } from 'vitest'

import {
  EMAIL_SEND_REQUESTED_DLQ_TOPIC,
  EMAIL_SEND_REQUESTED_RETRY_TOPIC,
  EMAIL_SEND_REQUESTED_TOPIC,
  EmailSendRequestedPayloadSchema
} from '../email-send-requested.schema.ts'
import { createMessageEnvelopeSchema } from '../message-envelope.schema.ts'

describe('EmailSendRequestedPayloadSchema', () => {
  const validPayload = {
    emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
    organizationId: '018f9a9e-6f0a-7c3e-9b0a-000000000002',
    projectId: '018f9a9e-6f0a-7c3e-9b0a-000000000003',
    from: 'sender@ruguin.dev',
    to: 'recipient@ruguin.dev',
    subject: 'Welcome',
    html: '<p>Hi</p>'
  }

  it('accepts a valid payload', () => {
    const result = EmailSendRequestedPayloadSchema.safeParse(validPayload)

    expect(result.success).toBe(true)
  })

  it('accepts a valid payload with an optional idempotencyKey', () => {
    const result = EmailSendRequestedPayloadSchema.safeParse({ ...validPayload, idempotencyKey: 'idem-1' })

    expect(result.success).toBe(true)
  })

  it('rejects a payload missing a required field', () => {
    const { subject: _subject, ...withoutSubject } = validPayload

    const result = EmailSendRequestedPayloadSchema.safeParse(withoutSubject)

    expect(result.success).toBe(false)
  })

  it('rejects an invalid "from" email address', () => {
    const result = EmailSendRequestedPayloadSchema.safeParse({ ...validPayload, from: 'not-an-email' })

    expect(result.success).toBe(false)
  })

  it('validates against the generic envelope', () => {
    const envelopeSchema = createMessageEnvelopeSchema(EmailSendRequestedPayloadSchema)

    const result = envelopeSchema.safeParse({
      eventId: '018f9a9e-6f0a-7c3e-9b0a-000000000004',
      name: 'email.send.requested',
      payload: validPayload
    })

    expect(result.success).toBe(true)
  })
})

describe('email.send.requested topic names', () => {
  it('exposes main, retry, and DLQ topic constants', () => {
    expect(EMAIL_SEND_REQUESTED_TOPIC).toBe('email.send.requested')
    expect(EMAIL_SEND_REQUESTED_RETRY_TOPIC).toBe('email.send.requested.retry')
    expect(EMAIL_SEND_REQUESTED_DLQ_TOPIC).toBe('email.send.requested.dlq')
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @ruguin/event-schemas test:unit`
Expected: FAIL — `Cannot find module '../email-send-requested.schema.ts'` (files don't exist yet).

- [ ] **Step 7: Create `src/message-envelope.schema.ts`**

```ts
import { z } from 'zod'

export function createMessageEnvelopeSchema<T extends z.ZodType>(payloadSchema: T) {
  return z.object({
    eventId: z.uuid(),
    name: z.string().min(1),
    payload: payloadSchema
  })
}
```

- [ ] **Step 8: Create `src/email-send-requested.schema.ts`**

```ts
import { z } from 'zod'

export const EMAIL_SEND_REQUESTED_TOPIC = 'email.send.requested'
export const EMAIL_SEND_REQUESTED_RETRY_TOPIC = 'email.send.requested.retry'
export const EMAIL_SEND_REQUESTED_DLQ_TOPIC = 'email.send.requested.dlq'

export const EmailSendRequestedPayloadSchema = z.object({
  emailId: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  from: z.email(),
  to: z.email(),
  subject: z.string().min(1),
  html: z.string().min(1),
  idempotencyKey: z.string().min(1).optional()
})

export type EmailSendRequestedPayload = z.infer<typeof EmailSendRequestedPayloadSchema>
```

- [ ] **Step 9: Create `src/index.ts`**

```ts
export * from './email-send-requested.schema.ts'
export * from './message-envelope.schema.ts'
```

- [ ] **Step 10: Install dependencies and run the test again**

Run: `pnpm install && pnpm --filter @ruguin/event-schemas test:unit`
Expected: PASS — all 6 tests green.

- [ ] **Step 11: Commit**

```bash
git add packages/event-schemas
git commit -m "feat(event-schemas): scaffold package and define email.send.requested contract"
```

---

### Task 2: `email.status.updated` contract

**Files:**

- Create: `packages/event-schemas/src/email-status-updated.schema.ts`
- Modify: `packages/event-schemas/src/index.ts`
- Test: `packages/event-schemas/src/__tests__/email-status-updated.schema.unit.ts`

**Interfaces:**

- Consumes: `createMessageEnvelopeSchema` (Task 1).
- Produces: `EmailStatusUpdatedStatus` (`'sent' | 'delivered' | 'bounced' | 'complained' | 'failed'`), `EmailStatusUpdatedPayloadSchema`, `type EmailStatusUpdatedPayload`, `EMAIL_STATUS_UPDATED_TOPIC`, `EMAIL_STATUS_UPDATED_DLQ_TOPIC` — consumed by Task 15 (`SendEmailUseCase` publishes this event).

- [ ] **Step 1: Write the failing test**

```ts
// packages/event-schemas/src/__tests__/email-status-updated.schema.unit.ts
import { describe, expect, it } from 'vitest'

import { EMAIL_STATUS_UPDATED_DLQ_TOPIC, EMAIL_STATUS_UPDATED_TOPIC, EmailStatusUpdatedPayloadSchema } from '../email-status-updated.schema.ts'

describe('EmailStatusUpdatedPayloadSchema', () => {
  it('accepts a "sent" status with a sesMessageId', () => {
    const result = EmailStatusUpdatedPayloadSchema.safeParse({
      emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
      status: 'sent',
      sesMessageId: 'ses-msg-1'
    })

    expect(result.success).toBe(true)
  })

  it('accepts a "failed" status with an errorMessage and no sesMessageId', () => {
    const result = EmailStatusUpdatedPayloadSchema.safeParse({
      emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
      status: 'failed',
      errorMessage: 'SES throttled the request'
    })

    expect(result.success).toBe(true)
  })

  it('rejects a status outside the allowed set', () => {
    const result = EmailStatusUpdatedPayloadSchema.safeParse({
      emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
      status: 'unknown'
    })

    expect(result.success).toBe(false)
  })

  it('exposes the main and DLQ topic constants', () => {
    expect(EMAIL_STATUS_UPDATED_TOPIC).toBe('email.status.updated')
    expect(EMAIL_STATUS_UPDATED_DLQ_TOPIC).toBe('email.status.updated.dlq')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ruguin/event-schemas test:unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/email-status-updated.schema.ts`**

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

export const EmailStatusUpdatedPayloadSchema = z.object({
  emailId: z.uuid(),
  status: z.enum(EmailStatusUpdatedStatus),
  sesMessageId: z.string().min(1).optional(),
  errorMessage: z.string().min(1).optional()
})

export type EmailStatusUpdatedPayload = z.infer<typeof EmailStatusUpdatedPayloadSchema>
```

- [ ] **Step 4: Add the export to `src/index.ts`**

```ts
export * from './email-send-requested.schema.ts'
export * from './email-status-updated.schema.ts'
export * from './message-envelope.schema.ts'
```

- [ ] **Step 5: Run tests again**

Run: `pnpm --filter @ruguin/event-schemas test:unit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/event-schemas
git commit -m "feat(event-schemas): define email.status.updated contract"
```

---

### Task 3: `email.engagement` contract (reserved)

**Files:**

- Create: `packages/event-schemas/src/email-engagement.schema.ts`
- Modify: `packages/event-schemas/src/index.ts`
- Test: `packages/event-schemas/src/__tests__/email-engagement.schema.unit.ts`

**Interfaces:**

- Produces: `EmailEngagementType` (`'open' | 'click'`), `EmailEngagementPayloadSchema`, `type EmailEngagementPayload`, `EMAIL_ENGAGEMENT_TOPIC`, `EMAIL_ENGAGEMENT_DLQ_TOPIC` — reserved for the future Tracking Service, not consumed by this plan's later tasks, but must exist so no other service reinvents these names.

- [ ] **Step 1: Write the failing test**

```ts
// packages/event-schemas/src/__tests__/email-engagement.schema.unit.ts
import { describe, expect, it } from 'vitest'

import { EMAIL_ENGAGEMENT_DLQ_TOPIC, EMAIL_ENGAGEMENT_TOPIC, EmailEngagementPayloadSchema } from '../email-engagement.schema.ts'

describe('EmailEngagementPayloadSchema', () => {
  it('accepts a valid "open" event', () => {
    const result = EmailEngagementPayloadSchema.safeParse({
      emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
      type: 'open',
      occurredAt: '2026-08-02T12:00:00.000Z'
    })

    expect(result.success).toBe(true)
  })

  it('rejects a type outside open/click', () => {
    const result = EmailEngagementPayloadSchema.safeParse({
      emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
      type: 'unsubscribe',
      occurredAt: '2026-08-02T12:00:00.000Z'
    })

    expect(result.success).toBe(false)
  })

  it('exposes the main and DLQ topic constants', () => {
    expect(EMAIL_ENGAGEMENT_TOPIC).toBe('email.engagement')
    expect(EMAIL_ENGAGEMENT_DLQ_TOPIC).toBe('email.engagement.dlq')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ruguin/event-schemas test:unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/email-engagement.schema.ts`**

```ts
import { z } from 'zod'

export const EMAIL_ENGAGEMENT_TOPIC = 'email.engagement'
export const EMAIL_ENGAGEMENT_DLQ_TOPIC = 'email.engagement.dlq'

export const EmailEngagementType = {
  OPEN: 'open',
  CLICK: 'click'
} as const

export const EmailEngagementPayloadSchema = z.object({
  emailId: z.uuid(),
  type: z.enum(EmailEngagementType),
  occurredAt: z.iso.datetime()
})

export type EmailEngagementPayload = z.infer<typeof EmailEngagementPayloadSchema>
```

- [ ] **Step 4: Add the export to `src/index.ts`**

```ts
export * from './email-engagement.schema.ts'
export * from './email-send-requested.schema.ts'
export * from './email-status-updated.schema.ts'
export * from './message-envelope.schema.ts'
```

- [ ] **Step 5: Run tests again**

Run: `pnpm --filter @ruguin/event-schemas test:unit`
Expected: PASS — `packages/event-schemas` is done.

- [ ] **Step 6: Commit**

```bash
git add packages/event-schemas
git commit -m "feat(event-schemas): define reserved email.engagement contract"
```

---

## Part 2 — `packages/message-broker`

### Task 4: Scaffold the package + producer/consumer ports

**Files:**

- Create: `packages/message-broker/package.json`
- Create: `packages/message-broker/tsconfig.json`
- Create: `packages/message-broker/eslint.config.ts`
- Create: `packages/message-broker/vitest.config.ts`
- Create: `packages/message-broker/tsdown.config.ts`
- Create: `packages/message-broker/src/domain/contracts/message-producer.port.ts`
- Create: `packages/message-broker/src/domain/contracts/message-consumer.port.ts`
- Create: `packages/message-broker/src/index.ts`
- Test: `packages/message-broker/src/domain/contracts/__tests__/message-producer.port.unit.ts`

**Interfaces:**

- Produces: `MESSAGE_PRODUCER_PORT`, `type OutboundMessage`, `interface MessageProducerPort`, `MESSAGE_CONSUMER_PORT`, `type InboundMessage`, `type SubscribeInput`, `interface MessageConsumerPort` — consumed by every later task in this package and by `apps/dispatch-worker`.

This package ships compiled output (like `packages/cache`), not raw TS like `packages/ddd-kernel` — later tasks add `@Injectable()`/`@Module()` decorators, which V8's type-stripping can't handle at runtime.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@ruguin/message-broker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.mts",
      "import": "./dist/index.mjs"
    }
  },
  "scripts": {
    "build": "tsdown",
    "check:lint": "eslint . --max-warnings 0",
    "check:types": "tsc --noEmit --pretty",
    "clean": "rm -rf .claude-flow .swarm .superpowers .remember .gitnexus .turbo coverage node_modules dist build",
    "fix:lint": "eslint --fix .",
    "test:all": "vitest run",
    "test:integration": "vitest run --project integration",
    "test:unit": "vitest run --project unit",
    "update:deps": "ncu -u"
  },
  "lint-staged": {
    "*.ts": "eslint --fix"
  },
  "dependencies": {
    "@nestjs/common": "^11.1.28",
    "@ruguin/ddd-kernel": "workspace:*",
    "@ruguin/env": "workspace:*",
    "@ruguin/utils": "workspace:*",
    "kafkajs": "^2.2.4",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2"
  },
  "devDependencies": {
    "@ruguin/eslint-config": "workspace:*",
    "@ruguin/typescript-config": "workspace:*",
    "@swc/core": "^1.15.47",
    "@types/node": "^26.1.2",
    "npm-check-updates": "23.0.0",
    "tsdown": "^0.22.14",
    "typescript": "6.0.3",
    "unplugin-swc": "^1.5.9",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ruguin/typescript-config/base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "./dist",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src/**/*.ts", "vitest.config.ts", "eslint.config.ts", "tsdown.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `eslint.config.ts`**

```ts
import { defineConfig } from '@ruguin/eslint-config'

export default defineConfig({})
```

- [ ] **Step 4: Create `tsdown.config.ts`**

```ts
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  dts: true,
  unbundle: false
})
```

- [ ] **Step 5: Create `vitest.config.ts`**

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
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/__tests__/**/*.unit.ts'], testTimeout: 5000 } },
      { extends: true, test: { name: 'integration', include: ['src/**/__tests__/**/*.int.ts'], testTimeout: 20_000 } }
    ]
  }
})
```

- [ ] **Step 6: Write the failing test for the producer port shape**

```ts
// packages/message-broker/src/domain/contracts/__tests__/message-producer.port.unit.ts
import { describe, expect, it } from 'vitest'
import { success } from '@ruguin/utils'

import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '../message-producer.port.ts'

describe('MessageProducerPort', () => {
  it('is implementable with the expected publish() shape', async () => {
    const producer: MessageProducerPort = {
      publish: async (input) => {
        expect(input.topic).toBe('email.send.requested')
        return success(undefined)
      }
    }

    const result = await producer.publish({
      topic: 'email.send.requested',
      key: 'email-1',
      message: { eventId: 'evt-1', name: 'email.send.requested', payload: { emailId: 'email-1' } }
    })

    expect(result.isSuccess()).toBe(true)
  })

  it('exposes a distinct DI token', () => {
    expect(typeof MESSAGE_PRODUCER_PORT).toBe('symbol')
  })
})
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @ruguin/message-broker test:unit`
Expected: FAIL — module not found.

- [ ] **Step 8: Create `src/domain/contracts/message-producer.port.ts`**

```ts
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either } from '@ruguin/utils'

export const MESSAGE_PRODUCER_PORT = Symbol('MESSAGE_PRODUCER_PORT')

export type OutboundMessage = Readonly<{
  topic: string
  key: string
  message: Readonly<{ eventId: string; name: string; payload: unknown }>
  headers?: Readonly<Record<string, string>>
}>

export interface MessageProducerPort {
  publish(input: OutboundMessage): Promise<Either<BaseError, void>>
}
```

This is the port moved out of `apps/core-server/src/shared/contracts/message-producer.port.ts` (or created fresh here if that worktree hasn't merged — see Global Constraints), extended with an optional `headers` field so the Dispatch Worker's retry consumer (Task 17) can carry `attempt`/`nextAttemptAt` metadata without touching the JSON payload contract.

- [ ] **Step 9: Create `src/domain/contracts/message-consumer.port.ts`**

```ts
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either } from '@ruguin/utils'

export const MESSAGE_CONSUMER_PORT = Symbol('MESSAGE_CONSUMER_PORT')

export type InboundMessage = Readonly<{
  eventId: string
  name: string
  payload: unknown
  headers: Readonly<Record<string, string>>
}>

export type MessageHandler = (message: InboundMessage) => Promise<Either<BaseError, void>>

export type SubscribeInput = Readonly<{
  topic: string
  groupId: string
  onMessage: MessageHandler
}>

export interface MessageConsumerPort {
  subscribe(input: SubscribeInput): Promise<Either<BaseError, void>>
}
```

Deliberately generic — it knows nothing about retry or backoff. That logic belongs to whoever calls `subscribe()` (Task 16/17 in `apps/dispatch-worker`), so the Webhook Notifier and Read-Model Updater can reuse this same port later without inheriting Dispatch-Worker-specific retry semantics.

- [ ] **Step 10: Create `src/index.ts`**

```ts
export * from './domain/contracts/message-consumer.port.ts'
export * from './domain/contracts/message-producer.port.ts'
```

- [ ] **Step 11: Install dependencies and run the test**

Run: `pnpm install && pnpm --filter @ruguin/message-broker test:unit`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/message-broker
git commit -m "feat(message-broker): scaffold package and define producer/consumer ports"
```

---

### Task 5: Domain errors + KafkaJS producer adapter

**Files:**

- Create: `packages/message-broker/src/domain/errors/message-publish.error.ts`
- Create: `packages/message-broker/src/infra/kafka/kafka-message-producer.ts`
- Modify: `packages/message-broker/src/index.ts`
- Test: `packages/message-broker/src/infra/kafka/__tests__/kafka-message-producer.unit.ts`

**Interfaces:**

- Consumes: `MessageProducerPort`, `OutboundMessage` (Task 4).
- Produces: `MessagePublishError`, `class KafkaMessageProducer implements MessageProducerPort` (constructor takes a KafkaJS `Producer`) — consumed by Task 7 (`MessageBrokerModule`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/message-broker/src/infra/kafka/__tests__/kafka-message-producer.unit.ts
import { describe, expect, it, vi } from 'vitest'
import { type Producer } from 'kafkajs'

import { KafkaMessageProducer } from '../kafka-message-producer.ts'

function fakeProducer(send: Producer['send']): Producer {
  return { send } as unknown as Producer
}

describe('KafkaMessageProducer', () => {
  it('publishes the message with the key and headers passed to it', async () => {
    const send = vi.fn().mockResolvedValue([])
    const producer = new KafkaMessageProducer(fakeProducer(send))

    const result = await producer.publish({
      topic: 'email.send.requested',
      key: 'email-1',
      message: { eventId: 'evt-1', name: 'email.send.requested', payload: { emailId: 'email-1' } },
      headers: { attempt: '1' }
    })

    expect(result.isSuccess()).toBe(true)
    expect(send).toHaveBeenCalledWith({
      topic: 'email.send.requested',
      messages: [
        {
          key: 'email-1',
          value: JSON.stringify({ eventId: 'evt-1', name: 'email.send.requested', payload: { emailId: 'email-1' } }),
          headers: { attempt: '1' }
        }
      ]
    })
  })

  it('returns a MessagePublishError when the underlying send() rejects', async () => {
    const send = vi.fn().mockRejectedValue(new Error('broker unreachable'))
    const producer = new KafkaMessageProducer(fakeProducer(send))

    const result = await producer.publish({
      topic: 'email.send.requested',
      key: 'email-1',
      message: { eventId: 'evt-1', name: 'email.send.requested', payload: {} }
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.name).toBe('MessagePublishError')
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ruguin/message-broker test:unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/domain/errors/message-publish.error.ts`**

```ts
import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class MessagePublishError extends BaseError {
  readonly name = 'MessagePublishError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { message: string; error?: unknown }) {
    super(input)
  }
}
```

- [ ] **Step 4: Create `src/infra/kafka/kafka-message-producer.ts`**

```ts
import { Injectable } from '@nestjs/common'
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either, failure, success } from '@ruguin/utils'
import { type Producer } from 'kafkajs'

import { MessagePublishError } from '../../domain/errors/message-publish.error.ts'
import { type MessageProducerPort, type OutboundMessage } from '../../domain/contracts/message-producer.port.ts'

@Injectable()
export class KafkaMessageProducer implements MessageProducerPort {
  constructor(private readonly producer: Producer) {}

  public async publish(input: OutboundMessage): Promise<Either<BaseError, void>> {
    try {
      await this.producer.send({
        topic: input.topic,
        messages: [
          {
            key: input.key,
            value: JSON.stringify(input.message),
            ...(input.headers !== undefined && { headers: input.headers })
          }
        ]
      })

      return success(undefined)
    } catch (error: unknown) {
      return failure(
        new MessagePublishError({ error, message: `Failed to publish to topic "${input.topic}".` })
      )
    }
  }
}
```

- [ ] **Step 5: Add exports to `src/index.ts`**

```ts
export * from './domain/contracts/message-consumer.port.ts'
export * from './domain/contracts/message-producer.port.ts'
export * from './domain/errors/message-publish.error.ts'
export * from './infra/kafka/kafka-message-producer.ts'
```

- [ ] **Step 6: Run tests again**

Run: `pnpm --filter @ruguin/message-broker test:unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/message-broker
git commit -m "feat(message-broker): add KafkaJS producer adapter"
```

---

### Task 6: KafkaJS consumer adapter

**Files:**

- Create: `packages/message-broker/src/domain/errors/message-consume.error.ts`
- Create: `packages/message-broker/src/infra/kafka/kafka-message-consumer.ts`
- Modify: `packages/message-broker/src/index.ts`
- Test: `packages/message-broker/src/infra/kafka/__tests__/kafka-message-consumer.unit.ts`

**Interfaces:**

- Consumes: `MessageConsumerPort`, `InboundMessage`, `SubscribeInput` (Task 4).
- Produces: `MessageConsumeError`, `class KafkaMessageConsumer implements MessageConsumerPort` (constructor takes a KafkaJS `Kafka` client) — consumed by Task 7.

- [ ] **Step 1: Write the failing test**

```ts
// packages/message-broker/src/infra/kafka/__tests__/kafka-message-consumer.unit.ts
import { describe, expect, it, vi } from 'vitest'
import { success } from '@ruguin/utils'
import { type Consumer, type Kafka } from 'kafkajs'

import { KafkaMessageConsumer } from '../kafka-message-consumer.ts'

function fakeKafka(consumer: Partial<Consumer>): Kafka {
  return { consumer: () => consumer as Consumer } as unknown as Kafka
}

describe('KafkaMessageConsumer', () => {
  it('connects, subscribes, and forwards each message to onMessage as InboundMessage', async () => {
    let eachMessage: (input: { message: { value: Buffer; headers?: Record<string, Buffer> } }) => Promise<void> = async () => {}

    const consumer: Partial<Consumer> = {
      connect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockImplementation(async (config: { eachMessage: typeof eachMessage }) => {
        eachMessage = config.eachMessage
      })
    }

    const onMessage = vi.fn().mockResolvedValue(success(undefined))
    const kafkaConsumer = new KafkaMessageConsumer(fakeKafka(consumer))

    const result = await kafkaConsumer.subscribe({ topic: 'email.send.requested', groupId: 'dispatch-worker', onMessage })

    expect(result.isSuccess()).toBe(true)
    expect(consumer.connect).toHaveBeenCalled()
    expect(consumer.subscribe).toHaveBeenCalledWith({ topic: 'email.send.requested', fromBeginning: false })

    await eachMessage({
      message: {
        value: Buffer.from(JSON.stringify({ eventId: 'evt-1', name: 'email.send.requested', payload: { emailId: 'e1' } })),
        headers: { attempt: Buffer.from('1') }
      }
    })

    expect(onMessage).toHaveBeenCalledWith({
      eventId: 'evt-1',
      name: 'email.send.requested',
      payload: { emailId: 'e1' },
      headers: { attempt: '1' }
    })
  })

  it('returns a MessageConsumeError when connect() rejects', async () => {
    const consumer: Partial<Consumer> = { connect: vi.fn().mockRejectedValue(new Error('unreachable')) }

    const result = await new KafkaMessageConsumer(fakeKafka(consumer)).subscribe({
      topic: 'email.send.requested',
      groupId: 'dispatch-worker',
      onMessage: vi.fn()
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.name).toBe('MessageConsumeError')
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ruguin/message-broker test:unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/domain/errors/message-consume.error.ts`**

```ts
import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class MessageConsumeError extends BaseError {
  readonly name = 'MessageConsumeError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { message: string; error?: unknown }) {
    super(input)
  }
}
```

- [ ] **Step 4: Create `src/infra/kafka/kafka-message-consumer.ts`**

```ts
import { Injectable } from '@nestjs/common'
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either, failure, success } from '@ruguin/utils'
import { type Kafka } from 'kafkajs'

import { type InboundMessage, type MessageConsumerPort, type SubscribeInput } from '../../domain/contracts/message-consumer.port.ts'
import { MessageConsumeError } from '../../domain/errors/message-consume.error.ts'

function decodeHeaders(headers: Record<string, Buffer | string | undefined> | undefined): Record<string, string> {
  if (headers === undefined) return {}

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, value === undefined ? '' : value.toString()])
  )
}

@Injectable()
export class KafkaMessageConsumer implements MessageConsumerPort {
  constructor(private readonly kafka: Kafka) {}

  public async subscribe(input: SubscribeInput): Promise<Either<BaseError, void>> {
    try {
      const consumer = this.kafka.consumer({ groupId: input.groupId })

      await consumer.connect()
      await consumer.subscribe({ topic: input.topic, fromBeginning: false })

      await consumer.run({
        eachMessage: async ({ message }) => {
          const parsed = JSON.parse(message.value?.toString() ?? '{}') as { eventId: string; name: string; payload: unknown }
          const inbound: InboundMessage = { ...parsed, headers: decodeHeaders(message.headers) }

          await input.onMessage(inbound)
        }
      })

      return success(undefined)
    } catch (error: unknown) {
      return failure(
        new MessageConsumeError({ error, message: `Failed to subscribe to topic "${input.topic}" (group "${input.groupId}").` })
      )
    }
  }
}
```

- [ ] **Step 5: Add exports to `src/index.ts`**

```ts
export * from './domain/contracts/message-consumer.port.ts'
export * from './domain/contracts/message-producer.port.ts'
export * from './domain/errors/message-consume.error.ts'
export * from './domain/errors/message-publish.error.ts'
export * from './infra/kafka/kafka-message-consumer.ts'
export * from './infra/kafka/kafka-message-producer.ts'
```

- [ ] **Step 6: Run tests again**

Run: `pnpm --filter @ruguin/message-broker test:unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/message-broker
git commit -m "feat(message-broker): add KafkaJS consumer adapter"
```

---

### Task 7: `MessageBrokerModule` + integration test against real Kafka

**Files:**

- Create: `packages/message-broker/src/nestjs/message-broker.tokens.ts`
- Create: `packages/message-broker/src/nestjs/message-broker.module.ts`
- Modify: `packages/message-broker/src/index.ts`
- Test: `packages/message-broker/src/nestjs/__tests__/message-broker.module.int.ts`

**Interfaces:**

- Consumes: `MESSAGE_PRODUCER_PORT`, `MESSAGE_CONSUMER_PORT`, `KafkaMessageProducer`, `KafkaMessageConsumer` (Tasks 4–6).
- Produces: `type MessageBrokerModuleOptions`, `class MessageBrokerModule` with `static forRoot(options): DynamicModule` — consumed by `apps/dispatch-worker`'s `app.module.ts` (Task 9) and, later, by `apps/core-server`'s (Task 8).

- [ ] **Step 1: Start the local Kafka stack (needed for the integration test in this task)**

Run: `pnpm infra:up` (from repo root)
Expected: `kafka`, `redis`, `redis-replica`, `localstack`, `postgres` containers healthy — confirm with `docker compose -f infrastructure/local/docker-compose.yml ps`.

- [ ] **Step 2: Write the failing integration test**

```ts
// packages/message-broker/src/nestjs/__tests__/message-broker.module.int.ts
import { Test } from '@nestjs/testing'
import { describe, expect, it } from 'vitest'

import { MESSAGE_CONSUMER_PORT, type MessageConsumerPort } from '../../domain/contracts/message-consumer.port.ts'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '../../domain/contracts/message-producer.port.ts'
import { MessageBrokerModule } from '../message-broker.module.ts'

const TEST_TOPIC = 'message-broker-integration-test'

describe('MessageBrokerModule (real Kafka)', () => {
  it('round-trips a published message back through the consumer', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MessageBrokerModule.forRoot({
          brokers: ['localhost:9092'],
          clientId: 'message-broker-int-test'
        })
      ]
    }).compile()

    const producer = moduleRef.get<MessageProducerPort>(MESSAGE_PRODUCER_PORT)
    const consumer = moduleRef.get<MessageConsumerPort>(MESSAGE_CONSUMER_PORT)

    const received: unknown[] = []

    await consumer.subscribe({
      topic: TEST_TOPIC,
      groupId: `message-broker-int-test-${Date.now()}`,
      onMessage: async (message) => {
        received.push(message)
        return { isFailure: () => false, isSuccess: () => true, value: undefined } as never
      }
    })

    await producer.publish({
      topic: TEST_TOPIC,
      key: 'round-trip',
      message: { eventId: 'evt-1', name: 'test.roundtrip', payload: { ok: true } }
    })

    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (received.length > 0) {
          clearInterval(interval)
          resolve(undefined)
        }
      }, 200)
    })

    expect(received[0]).toMatchObject({ eventId: 'evt-1', name: 'test.roundtrip', payload: { ok: true } })

    await moduleRef.close()
  }, 20_000)
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @ruguin/message-broker test:integration`
Expected: FAIL — `MessageBrokerModule` not found.

- [ ] **Step 4: Create `src/nestjs/message-broker.tokens.ts`**

```ts
export const KAFKA_CLIENT = Symbol('KAFKA_CLIENT')
export const KAFKA_PRODUCER = Symbol('KAFKA_PRODUCER')
```

- [ ] **Step 5: Create `src/nestjs/message-broker.module.ts`**

```ts
import { type DynamicModule, Inject, Module } from '@nestjs/common'
import { Kafka, type Producer } from 'kafkajs'

import { MESSAGE_CONSUMER_PORT } from '../domain/contracts/message-consumer.port.ts'
import { MESSAGE_PRODUCER_PORT } from '../domain/contracts/message-producer.port.ts'
import { KafkaMessageConsumer } from '../infra/kafka/kafka-message-consumer.ts'
import { KafkaMessageProducer } from '../infra/kafka/kafka-message-producer.ts'

import { KAFKA_CLIENT, KAFKA_PRODUCER } from './message-broker.tokens.ts'

export type MessageBrokerModuleOptions = Readonly<{
  brokers: readonly string[]
  clientId: string
  ssl?: boolean
  isGlobal?: boolean
}>

@Module({})
export class MessageBrokerModule {
  public static forRoot(options: MessageBrokerModuleOptions): DynamicModule {
    const { isGlobal = false, ...config } = options

    return {
      module: MessageBrokerModule,
      global: isGlobal,
      providers: [
        {
          provide: KAFKA_CLIENT,
          useFactory: (): Kafka =>
            new Kafka({ brokers: [...config.brokers], clientId: config.clientId, ssl: config.ssl ?? false })
        },
        {
          provide: KAFKA_PRODUCER,
          useFactory: async (kafka: Kafka): Promise<Producer> => {
            const producer = kafka.producer()
            await producer.connect()
            return producer
          },
          inject: [KAFKA_CLIENT]
        },
        {
          provide: MESSAGE_PRODUCER_PORT,
          useFactory: (producer: Producer): KafkaMessageProducer => new KafkaMessageProducer(producer),
          inject: [KAFKA_PRODUCER]
        },
        {
          provide: MESSAGE_CONSUMER_PORT,
          useFactory: (kafka: Kafka): KafkaMessageConsumer => new KafkaMessageConsumer(kafka),
          inject: [KAFKA_CLIENT]
        }
      ],
      exports: [MESSAGE_PRODUCER_PORT, MESSAGE_CONSUMER_PORT]
    }
  }
}
```

`@Inject` is imported but unused directly here — remove it if `check:lint` flags it (the providers use the `inject` array on `useFactory`, not constructor injection, inside this static method).

- [ ] **Step 6: Fix Step 5 — remove the unused `Inject` import**

```ts
import { type DynamicModule, Module } from '@nestjs/common'
```

- [ ] **Step 7: Add exports to `src/index.ts`**

```ts
export * from './domain/contracts/message-consumer.port.ts'
export * from './domain/contracts/message-producer.port.ts'
export * from './domain/errors/message-consume.error.ts'
export * from './domain/errors/message-publish.error.ts'
export * from './infra/kafka/kafka-message-consumer.ts'
export * from './infra/kafka/kafka-message-producer.ts'
export * from './nestjs/message-broker.module.ts'
```

- [ ] **Step 8: Run the integration test**

Run: `pnpm --filter @ruguin/message-broker test:integration`
Expected: PASS — message published to `message-broker-integration-test` is received back through the consumer within the poll loop.

- [ ] **Step 9: Run unit tests too, to make sure nothing broke**

Run: `pnpm --filter @ruguin/message-broker test:unit`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/message-broker
git commit -m "feat(message-broker): add MessageBrokerModule wiring producer and consumer"
```

---

## Part 3 — `apps/dispatch-worker`

### Task 8: Scaffold the app + `GET /health`

**Files:**

- Create: `apps/dispatch-worker/package.json`
- Create: `apps/dispatch-worker/tsconfig.json`
- Create: `apps/dispatch-worker/eslint.config.ts`
- Create: `apps/dispatch-worker/vitest.config.ts`
- Create: `apps/dispatch-worker/vitest.setup.e2e.ts`
- Create: `apps/dispatch-worker/src/main.ts`
- Create: `apps/dispatch-worker/src/app.module.ts`
- Create: `apps/dispatch-worker/src/health/health.module.ts`
- Create: `apps/dispatch-worker/src/health/health.controller.ts`
- Test: `apps/dispatch-worker/src/health/__tests__/health.controller.e2e.ts`

**Interfaces:**

- Consumes: `CacheModule`, `CacheHealthIndicator` (`@ruguin/cache`).
- Produces: a booting NestJS app answering `GET /health` — every later task in this app imports `AppModule`/relies on the app booting cleanly.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@ruguin/dispatch-worker",
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "build": "nest build && node ../core-server/scripts/fix-esm-imports.mjs",
    "check:lint": "eslint . --max-warnings 0",
    "check:types": "tsc --noEmit --pretty",
    "clean": "rm -rf .claude-flow .swarm .superpowers .remember .gitnexus .turbo coverage node_modules dist build",
    "dev": "nodemon --watch src --ext ts --exec \"pnpm run build && pnpm run start\"",
    "fix:lint": "eslint --fix .",
    "start": "node dist/main.js",
    "start:dev": "nodemon --watch src --ext ts --exec \"pnpm run build && pnpm run start\"",
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
    "@ruguin/cache": "workspace:*",
    "@ruguin/ddd-kernel": "workspace:*",
    "@ruguin/env": "workspace:*",
    "@ruguin/event-schemas": "workspace:*",
    "@ruguin/message-broker": "workspace:*",
    "@ruguin/utils": "workspace:*",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2"
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
    "typescript": "6.0.3",
    "unplugin-swc": "^1.5.9",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ruguin/typescript-config/base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "./dist",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src/**/*.ts", "vitest.config.ts", "eslint.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `eslint.config.ts`**

```ts
import { defineConfig } from '@ruguin/eslint-config'

export default defineConfig({})
```

- [ ] **Step 4: Create `vitest.config.ts`**

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

- [ ] **Step 5: Create `vitest.setup.e2e.ts`**

```ts
import 'reflect-metadata'
```

- [ ] **Step 6: Write the failing e2e test**

```ts
// apps/dispatch-worker/src/health/__tests__/health.controller.e2e.ts
import { type INestApplication } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AppModule } from '../../app.module.ts'

describe('GET /health', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.init()
    await (app as unknown as NestFastifyApplication).getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 200 with cache reported as up', async () => {
    const response = await app.getHttpServer().inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toMatchObject({ status: 'ok', info: { cache: { status: 'up' } } })
  })
})
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @ruguin/dispatch-worker test:e2e`
Expected: FAIL — `app.module.ts` not found.

- [ ] **Step 8: Create `src/health/health.controller.ts`**

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

- [ ] **Step 9: Create `src/health/health.module.ts`**

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

- [ ] **Step 10: Create `src/app.module.ts`**

```ts
import { Module } from '@nestjs/common'
import { CacheModule } from '@ruguin/cache'
import { cacheENV } from '@ruguin/env'

import { HealthModule } from './health/health.module.ts'

@Module({
  imports: [
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

This inlines the same option-mapping `apps/core-server`'s `createCacheModuleOptions()` does — Task 11 extracts it into a shared `shared/infrastructure/cache/cache-module-options.ts` once the `email` module needs `CacheModule` wired the same way.

- [ ] **Step 11: Create `src/main.ts`**

```ts
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'

import { AppModule } from './app.module.ts'

const PORT = 3334

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
  bufferLogs: true
})
app.enableShutdownHooks()
await app.listen(PORT, '0.0.0.0')
```

Port `3334` is a placeholder one above `core-server`'s `3333` — Task 10 replaces it with a validated env var once the app's own env schema exists.

- [ ] **Step 12: Install dependencies and run the e2e test**

Run: `pnpm install && pnpm --filter @ruguin/dispatch-worker test:e2e`
Expected: PASS — requires `CACHE_DRIVER=memory` (or a running Redis) in the test environment; the `memory` driver default means no external service is required for this test to pass.

- [ ] **Step 13: Commit**

```bash
git add apps/dispatch-worker
git commit -m "feat(dispatch-worker): scaffold NestJS app with GET /health"
```

---

### Task 9: Wire `apps/core-server` onto `packages/message-broker`

**Files:**

- Modify: `apps/core-server/src/shared/contracts/message-producer.port.ts` (delete, if present)
- Modify: `apps/core-server/src/shared/events/fake-message-producer.ts` (delete, if present)
- Modify: `apps/core-server/src/shared/outbox/outbox-relay.service.ts` (update import, if present)
- Modify: `apps/core-server/src/app.module.ts`
- Modify: `apps/core-server/package.json`
- Create: `apps/core-server/src/shared/infrastructure/message-broker/message-broker-module-options.ts`

**Interfaces:**

- Consumes: `MessageBrokerModule`, `MESSAGE_PRODUCER_PORT` (Task 7).

**Note before starting:** as of this plan's writing, `message-producer.port.ts`, `fake-message-producer.ts`, and `outbox-relay.service.ts` exist only in the sibling worktree `core-server-outbox-design`, not on `develop` — check first with `find apps/core-server/src -iname "*message-producer*" -o -iname "*outbox-relay*"`. If nothing is found, that worktree hasn't merged yet: skip Steps 1–3 below (there's nothing to delete/update) and do only Step 4 onward (wiring `MessageBrokerModule` into `app.module.ts`) — the outbox work will import `MESSAGE_PRODUCER_PORT` from `@ruguin/message-broker` directly when it lands, since that's now the only place the port is defined.

- [ ] **Step 1: If present, delete the local port file**

```bash
rm -f apps/core-server/src/shared/contracts/message-producer.port.ts
```

- [ ] **Step 2: If present, delete the local fake producer and its test**

```bash
rm -f apps/core-server/src/shared/events/fake-message-producer.ts \
      apps/core-server/src/shared/events/__tests__/fake-message-producer.unit.ts
```

- [ ] **Step 3: If present, update `outbox-relay.service.ts`'s import**

Change:

```ts
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '../contracts/message-producer.port'
```

to:

```ts
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '@ruguin/message-broker'
```

- [ ] **Step 4: Add `@ruguin/message-broker` to `apps/core-server/package.json` dependencies**

```json
"@ruguin/message-broker": "workspace:*",
```

(insert alphabetically among the existing `@ruguin/*` dependencies)

- [ ] **Step 5: Create `src/shared/infrastructure/message-broker/message-broker-module-options.ts`**

```ts
import { type MessageBrokerModuleOptions } from '@ruguin/message-broker'
import { messageBrokerENV } from '@ruguin/env'

export function createMessageBrokerModuleOptions(): MessageBrokerModuleOptions {
  return {
    brokers: messageBrokerENV.KAFKA_BOOTSTRAP_BROKERS.split(','),
    clientId: messageBrokerENV.KAFKA_CLIENT_ID,
    ssl: messageBrokerENV.KAFKA_SSL
  }
}
```

- [ ] **Step 6: Wire `MessageBrokerModule` into `app.module.ts`**

Add the import and register the module:

```ts
import { MessageBrokerModule } from '@ruguin/message-broker'
// ...
import { createMessageBrokerModuleOptions } from './shared/infrastructure/message-broker/message-broker-module-options'

@Module({
  imports: [
    LoggerModule.forRootAsync({ useFactory: () => ({ pinoHttp: createPinoHttpOptions() }) }),
    CacheModule.forRoot({ isGlobal: true, ...createCacheModuleOptions() }),
    MessageBrokerModule.forRoot({ isGlobal: true, ...createMessageBrokerModuleOptions() }),
    DatabaseModule.forRoot({ connectionString: databaseENV.DATABASE_URL }),
    HealthModule
  ],
  controllers: [],
  providers: []
})
export class AppModule {}
```

- [ ] **Step 7: Run the full core-server test suite to confirm nothing broke**

Run: `pnpm --filter @ruguin/core-server test:all`
Expected: PASS. If Steps 1–3 were skipped (outbox work not yet merged), this only exercises the existing health/cache/database tests plus the new module import — still expected to PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/core-server
git commit -m "refactor(core-server): consume MessageProducerPort from @ruguin/message-broker"
```

---

### Task 10: AWS/SES env schema

**Files:**

- Create: `packages/env/src/packages/aws.environment.ts`
- Modify: `packages/env/src/packages/index.ts`
- Test: `packages/env/src/packages/__tests__/aws.environment.unit.ts`

**Interfaces:**

- Produces: `awsENV` (`AWS_REGION`, `AWS_ENDPOINT_URL?`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SES_FROM_ADDRESS`, `SES_SEND_RATE_LIMIT_PER_SECOND`) — consumed by Task 13 (`SesEmailSender`) and Task 14 (rate limiter defaults).

- [ ] **Step 1: Write the failing test**

```ts
// packages/env/src/packages/__tests__/aws.environment.unit.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('awsENV', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.AWS_ACCESS_KEY_ID = 'test'
    process.env.AWS_SECRET_ACCESS_KEY = 'test'
    process.env.SES_FROM_ADDRESS = 'sender@ruguin.dev'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('defaults AWS_REGION to us-east-1 and SES_SEND_RATE_LIMIT_PER_SECOND to 14', async () => {
    const { awsENV } = await import('../aws.environment.ts')

    expect(awsENV.AWS_REGION).toBe('us-east-1')
    expect(awsENV.SES_SEND_RATE_LIMIT_PER_SECOND).toBe(14)
  })

  it('reads AWS_ENDPOINT_URL when set, for LocalStack', async () => {
    process.env.AWS_ENDPOINT_URL = 'http://localhost:4566'

    const { awsENV } = await import('../aws.environment.ts')

    expect(awsENV.AWS_ENDPOINT_URL).toBe('http://localhost:4566')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ruguin/env test:unit`
Expected: FAIL — module not found. (Note: `lazyEnvironment` caches on first property access; this test file imports the module fresh in each `it()` via dynamic `import()`, but Vitest's module cache means the second `it()` may see the first's cached values in a real run — if that happens, add `vi.resetModules()` at the top of each `it()` before the dynamic import.)

- [ ] **Step 3: Create `src/packages/aws.environment.ts`**

```ts
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { lazyEnvironment } from '../shared/lazy-environment.ts'

export const awsENV = lazyEnvironment(() =>
  createEnv({
    server: {
      AWS_REGION: z.string().min(1).default('us-east-1'),
      AWS_ENDPOINT_URL: z.url().optional(),
      AWS_ACCESS_KEY_ID: z.string().min(1),
      AWS_SECRET_ACCESS_KEY: z.string().min(1),
      SES_FROM_ADDRESS: z.email(),
      SES_SEND_RATE_LIMIT_PER_SECOND: z.coerce.number().int().positive().default(14)
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
```

- [ ] **Step 4: Add the export to `src/packages/index.ts`**

```ts
export * from './aws.environment.ts'
export * from './cache.environment.ts'
export * from './database.environment.ts'
export * from './docs.environment.ts'
export * from './logger.environment.ts'
export * from './message-broker.environment.ts'
export * from './token-provider.environment.ts'
```

- [ ] **Step 5: Fix the test if `vi.resetModules()` is needed**

If Step 2's caching issue reproduces, update the test to call `vi.resetModules()` before each dynamic import:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ... inside each it():
vi.resetModules()
const { awsENV } = await import('../aws.environment.ts')
```

- [ ] **Step 6: Run tests again**

Run: `pnpm --filter @ruguin/env test:unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/env
git commit -m "feat(env): add AWS/SES environment schema"
```

---

### Task 11: Redis dedup claim provider

**Files:**

- Create: `apps/dispatch-worker/src/email/application/providers/dedup-claim.port.ts`
- Create: `apps/dispatch-worker/src/email/infra/redis/redis-dedup-claim.ts`
- Test: `apps/dispatch-worker/src/email/infra/redis/__tests__/redis-dedup-claim.unit.ts`

**Interfaces:**

- Produces: `DEDUP_CLAIM_PROVIDER`, `interface DedupClaimPort`, `class RedisDedupClaim implements DedupClaimPort` — consumed by Task 15 (`SendEmailUseCase`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/dispatch-worker/src/email/infra/redis/__tests__/redis-dedup-claim.unit.ts
import { describe, expect, it, vi } from 'vitest'
import { type ICacheProvider } from '@ruguin/cache'
import { success } from '@ruguin/utils'

import { RedisDedupClaim } from '../redis-dedup-claim.ts'

function fakeCache(setIfNotExists: ICacheProvider['setIfNotExists']): ICacheProvider {
  return { setIfNotExists } as unknown as ICacheProvider
}

describe('RedisDedupClaim', () => {
  it('claims a key that has never been claimed before', async () => {
    const setIfNotExists = vi.fn().mockResolvedValue(success({ stored: true }))
    const claim = new RedisDedupClaim(fakeCache(setIfNotExists))

    const result = await claim.claim({ key: 'email-1:0', ttlInMs: 60_000 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.claimed).toBe(true)
    }
    expect(setIfNotExists).toHaveBeenCalledWith({
      key: 'email-1:0',
      namespace: 'dispatch-worker:dedup',
      value: true,
      ttlInMs: 60_000
    })
  })

  it('does not claim a key that is already claimed', async () => {
    const setIfNotExists = vi.fn().mockResolvedValue(success({ stored: false }))
    const claim = new RedisDedupClaim(fakeCache(setIfNotExists))

    const result = await claim.claim({ key: 'email-1:0', ttlInMs: 60_000 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.claimed).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ruguin/dispatch-worker test`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/email/application/providers/dedup-claim.port.ts`**

```ts
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either } from '@ruguin/utils'

export const DEDUP_CLAIM_PROVIDER = Symbol('DEDUP_CLAIM_PROVIDER')

export type DedupClaimInput = Readonly<{ key: string; ttlInMs: number }>
export type DedupClaimOutput = Readonly<{ claimed: boolean }>

export interface DedupClaimPort {
  claim(input: DedupClaimInput): Promise<Either<BaseError, DedupClaimOutput>>
}
```

- [ ] **Step 4: Create `src/email/infra/redis/redis-dedup-claim.ts`**

```ts
import { Inject, Injectable } from '@nestjs/common'
import { type ICacheProvider, InjectCache } from '@ruguin/cache'
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either, failure, success } from '@ruguin/utils'

import {
  type DedupClaimInput,
  type DedupClaimOutput,
  type DedupClaimPort
} from '../../application/providers/dedup-claim.port.ts'

const NAMESPACE = 'dispatch-worker:dedup'

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
}
```

`Inject` is imported but unused — the constructor uses `@InjectCache()` instead. Remove the unused import in the next step.

- [ ] **Step 5: Fix Step 4 — remove the unused `Inject` import**

```ts
import { Injectable } from '@nestjs/common'
```

- [ ] **Step 6: Run tests again**

Run: `pnpm --filter @ruguin/dispatch-worker test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/dispatch-worker
git commit -m "feat(dispatch-worker): add Redis-backed idempotency claim"
```

---

### Task 12: Redis rate limiter provider

**Files:**

- Create: `apps/dispatch-worker/src/email/application/providers/rate-limiter.port.ts`
- Create: `apps/dispatch-worker/src/email/infra/redis/redis-rate-limiter.ts`
- Test: `apps/dispatch-worker/src/email/infra/redis/__tests__/redis-rate-limiter.unit.ts`

**Interfaces:**

- Produces: `RATE_LIMITER_PROVIDER`, `interface RateLimiterPort`, `class RedisRateLimiter implements RateLimiterPort` — consumed by Task 15.

- [ ] **Step 1: Write the failing test**

```ts
// apps/dispatch-worker/src/email/infra/redis/__tests__/redis-rate-limiter.unit.ts
import { describe, expect, it, vi } from 'vitest'
import { type ICacheProvider } from '@ruguin/cache'
import { success } from '@ruguin/utils'

import { RedisRateLimiter } from '../redis-rate-limiter.ts'

function fakeCache(increment: ICacheProvider['increment']): ICacheProvider {
  return { increment } as unknown as ICacheProvider
}

describe('RedisRateLimiter', () => {
  it('allows the request when the counter is within the limit', async () => {
    const increment = vi.fn().mockResolvedValue(success({ value: 3 }))
    const limiter = new RedisRateLimiter(fakeCache(increment))

    const result = await limiter.check({ key: 'ses-account', limit: 14, windowInMs: 1000 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.allowed).toBe(true)
    }
    expect(increment).toHaveBeenCalledWith({ key: 'ses-account', namespace: 'dispatch-worker:rate-limit', windowInMs: 1000 })
  })

  it('denies the request when the counter exceeds the limit', async () => {
    const increment = vi.fn().mockResolvedValue(success({ value: 15 }))
    const limiter = new RedisRateLimiter(fakeCache(increment))

    const result = await limiter.check({ key: 'ses-account', limit: 14, windowInMs: 1000 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.allowed).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ruguin/dispatch-worker test`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/email/application/providers/rate-limiter.port.ts`**

```ts
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either } from '@ruguin/utils'

export const RATE_LIMITER_PROVIDER = Symbol('RATE_LIMITER_PROVIDER')

export type RateLimiterCheckInput = Readonly<{ key: string; limit: number; windowInMs: number }>
export type RateLimiterCheckOutput = Readonly<{ allowed: boolean }>

export interface RateLimiterPort {
  check(input: RateLimiterCheckInput): Promise<Either<BaseError, RateLimiterCheckOutput>>
}
```

- [ ] **Step 4: Create `src/email/infra/redis/redis-rate-limiter.ts`**

```ts
import { Injectable } from '@nestjs/common'
import { type ICacheProvider, InjectCache } from '@ruguin/cache'
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either, failure, success } from '@ruguin/utils'

import {
  type RateLimiterCheckInput,
  type RateLimiterCheckOutput,
  type RateLimiterPort
} from '../../application/providers/rate-limiter.port.ts'

const NAMESPACE = 'dispatch-worker:rate-limit'

@Injectable()
export class RedisRateLimiter implements RateLimiterPort {
  constructor(@InjectCache() private readonly cache: ICacheProvider) {}

  public async check(input: RateLimiterCheckInput): Promise<Either<BaseError, RateLimiterCheckOutput>> {
    const result = await this.cache.increment({ key: input.key, namespace: NAMESPACE, windowInMs: input.windowInMs })

    if (result.isFailure()) return failure(result.value)

    return success({ allowed: result.value.value <= input.limit })
  }
}
```

This is a fixed-window counter (anchored to the first increment in the window), not a continuously-refilling token bucket — `@ruguin/cache`'s public API has no built-in refilling-bucket primitive, and building one would require a custom Lua script the package doesn't expose. Adequate for the SES account-wide requests/second guard; documented as a known limitation in the design spec.

- [ ] **Step 5: Run tests again**

Run: `pnpm --filter @ruguin/dispatch-worker test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/dispatch-worker
git commit -m "feat(dispatch-worker): add Redis-backed rate limiter"
```

---

### Task 13: SES email sender adapter

**Files:**

- Create: `apps/dispatch-worker/src/email/application/providers/email-sender.port.ts`
- Create: `apps/dispatch-worker/src/email/domain/errors/ses-send.error.ts`
- Create: `apps/dispatch-worker/src/email/infra/ses/ses-email-sender.ts`
- Modify: `apps/dispatch-worker/package.json`
- Test: `apps/dispatch-worker/src/email/infra/ses/__tests__/ses-email-sender.unit.ts`

**Interfaces:**

- Produces: `EMAIL_SENDER_PROVIDER`, `interface EmailSenderPort`, `SesSendError`, `class SesEmailSender implements EmailSenderPort` — consumed by Task 15.

- [ ] **Step 1: Add `@aws-sdk/client-ses` to `package.json` dependencies**

```json
"@aws-sdk/client-ses": "^3.700.0",
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/dispatch-worker/src/email/infra/ses/__tests__/ses-email-sender.unit.ts
import { describe, expect, it, vi } from 'vitest'
import { type SESClient } from '@aws-sdk/client-ses'

import { SesEmailSender } from '../ses-email-sender.ts'

function fakeSesClient(send: SESClient['send']): SESClient {
  return { send } as unknown as SESClient
}

describe('SesEmailSender', () => {
  it('sends the email and returns the SES message id', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: 'ses-msg-1' })
    const sender = new SesEmailSender(fakeSesClient(send))

    const result = await sender.send({ from: 'a@ruguin.dev', to: 'b@ruguin.dev', subject: 'Hi', html: '<p>Hi</p>' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.sesMessageId).toBe('ses-msg-1')
    }
  })

  it('returns a SesSendError when the SDK call rejects', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Throttled'))
    const sender = new SesEmailSender(fakeSesClient(send))

    const result = await sender.send({ from: 'a@ruguin.dev', to: 'b@ruguin.dev', subject: 'Hi', html: '<p>Hi</p>' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.name).toBe('SesSendError')
    }
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm install && pnpm --filter @ruguin/dispatch-worker test`
Expected: FAIL — module not found.

- [ ] **Step 4: Create `src/email/application/providers/email-sender.port.ts`**

```ts
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either } from '@ruguin/utils'

export const EMAIL_SENDER_PROVIDER = Symbol('EMAIL_SENDER_PROVIDER')

export type SendEmailInput = Readonly<{ from: string; to: string; subject: string; html: string }>
export type SendEmailOutput = Readonly<{ sesMessageId: string }>

export interface EmailSenderPort {
  send(input: SendEmailInput): Promise<Either<BaseError, SendEmailOutput>>
}
```

- [ ] **Step 5: Create `src/email/domain/errors/ses-send.error.ts`**

```ts
import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class SesSendError extends BaseError {
  readonly name = 'SesSendError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { message: string; error?: unknown }) {
    super(input)
  }
}
```

- [ ] **Step 6: Create `src/email/infra/ses/ses-email-sender.ts`**

```ts
import { Injectable } from '@nestjs/common'
import { SendEmailCommand, type SESClient } from '@aws-sdk/client-ses'
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either, failure, success } from '@ruguin/utils'

import {
  type EmailSenderPort,
  type SendEmailInput,
  type SendEmailOutput
} from '../../application/providers/email-sender.port.ts'
import { SesSendError } from '../../domain/errors/ses-send.error.ts'

@Injectable()
export class SesEmailSender implements EmailSenderPort {
  constructor(private readonly client: SESClient) {}

  public async send(input: SendEmailInput): Promise<Either<BaseError, SendEmailOutput>> {
    try {
      const response = await this.client.send(
        new SendEmailCommand({
          Source: input.from,
          Destination: { ToAddresses: [input.to] },
          Message: {
            Subject: { Data: input.subject },
            Body: { Html: { Data: input.html } }
          }
        })
      )

      return success({ sesMessageId: response.MessageId ?? '' })
    } catch (error: unknown) {
      return failure(new SesSendError({ error, message: `Failed to send email from "${input.from}" to "${input.to}" via SES.` }))
    }
  }
}
```

- [ ] **Step 7: Run tests again**

Run: `pnpm --filter @ruguin/dispatch-worker test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/dispatch-worker
git commit -m "feat(dispatch-worker): add SES email sender adapter"
```

---

### Task 14: Retry backoff helper

**Files:**

- Create: `apps/dispatch-worker/src/email/application/retry-backoff.ts`
- Test: `apps/dispatch-worker/src/email/application/__tests__/retry-backoff.unit.ts`

**Interfaces:**

- Produces: `MAX_RETRY_ATTEMPTS` (`3`), `computeNextRetryAt(attempt: number): Date`, `hasExhaustedRetries(nextAttempt: number): boolean` — consumed by Task 15.

- [ ] **Step 1: Write the failing test**

```ts
// apps/dispatch-worker/src/email/application/__tests__/retry-backoff.unit.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { computeNextRetryAt, hasExhaustedRetries, MAX_RETRY_ATTEMPTS } from '../retry-backoff.ts'

describe('retry-backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('computes ~10s / ~20s / ~40s for attempts 1, 2, 3', () => {
    expect(computeNextRetryAt(1)).toEqual(new Date('2026-08-02T12:00:10.000Z'))
    expect(computeNextRetryAt(2)).toEqual(new Date('2026-08-02T12:00:20.000Z'))
    expect(computeNextRetryAt(3)).toEqual(new Date('2026-08-02T12:00:40.000Z'))
  })

  it('exposes 3 as the max retry attempts', () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(3)
  })

  it('has not exhausted retries for attempt 1, 2, or 3', () => {
    expect(hasExhaustedRetries(1)).toBe(false)
    expect(hasExhaustedRetries(2)).toBe(false)
    expect(hasExhaustedRetries(3)).toBe(false)
  })

  it('has exhausted retries once the next attempt would be 4', () => {
    expect(hasExhaustedRetries(4)).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ruguin/dispatch-worker test`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/email/application/retry-backoff.ts`**

```ts
const BASE_BACKOFF_MS = 5000

export const MAX_RETRY_ATTEMPTS = 3

export function computeNextRetryAt(attempt: number): Date {
  return new Date(Date.now() + BASE_BACKOFF_MS * 2 ** attempt)
}

export function hasExhaustedRetries(nextAttempt: number): boolean {
  return nextAttempt > MAX_RETRY_ATTEMPTS
}
```

- [ ] **Step 4: Run tests again**

Run: `pnpm --filter @ruguin/dispatch-worker test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dispatch-worker
git commit -m "feat(dispatch-worker): add exponential retry backoff helper"
```

---

### Task 15: `SendEmailUseCase`

**Files:**

- Create: `apps/dispatch-worker/src/email/application/use-cases/send-email.use-case.ts`
- Test: `apps/dispatch-worker/src/email/application/use-cases/__tests__/send-email.use-case.unit.ts`

**Interfaces:**

- Consumes: `DedupClaimPort` (Task 11), `RateLimiterPort` (Task 12), `EmailSenderPort` (Task 13), `computeNextRetryAt`/`hasExhaustedRetries`/`MAX_RETRY_ATTEMPTS` (Task 14), `MessageProducerPort`/`EMAIL_STATUS_UPDATED_TOPIC` (`@ruguin/message-broker`, `@ruguin/event-schemas`), `EMAIL_SEND_REQUESTED_RETRY_TOPIC`/`EMAIL_SEND_REQUESTED_DLQ_TOPIC` (`@ruguin/event-schemas`).
- Produces: `type SendEmailUseCaseInput`, `type SendEmailUseCaseOutput` (`{ outcome: 'sent' | 'skipped-duplicate' | 'retry-scheduled' | 'exhausted' }`), `class SendEmailUseCase` with `execute(input): Promise<Either<BaseError, SendEmailUseCaseOutput>>` — consumed by Task 16 and Task 17.

- [ ] **Step 1: Write the failing test**

```ts
// apps/dispatch-worker/src/email/application/use-cases/__tests__/send-email.use-case.unit.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMAIL_SEND_REQUESTED_DLQ_TOPIC, EMAIL_SEND_REQUESTED_RETRY_TOPIC } from '@ruguin/event-schemas'
import { EMAIL_STATUS_UPDATED_TOPIC } from '@ruguin/event-schemas'
import { type MessageProducerPort } from '@ruguin/message-broker'
import { success } from '@ruguin/utils'

import { type DedupClaimPort } from '../../providers/dedup-claim.port.ts'
import { type EmailSenderPort } from '../../providers/email-sender.port.ts'
import { type RateLimiterPort } from '../../providers/rate-limiter.port.ts'
import { SendEmailUseCase } from '../send-email.use-case.ts'

const BASE_INPUT = {
  emailId: 'email-1',
  from: 'a@ruguin.dev',
  to: 'b@ruguin.dev',
  subject: 'Hi',
  html: '<p>Hi</p>',
  attempt: 0
}

function buildUseCase(overrides: {
  claimed?: boolean
  allowed?: boolean
  sendResult?: 'success' | 'failure'
}) {
  const dedupClaim: DedupClaimPort = {
    claim: vi.fn().mockResolvedValue(success({ claimed: overrides.claimed ?? true }))
  }
  const rateLimiter: RateLimiterPort = {
    check: vi.fn().mockResolvedValue(success({ allowed: overrides.allowed ?? true }))
  }
  const emailSender: EmailSenderPort = {
    send:
      overrides.sendResult === 'failure'
        ? vi.fn().mockResolvedValue({ isFailure: () => true, isSuccess: () => false, value: { message: 'SES down' } })
        : vi.fn().mockResolvedValue(success({ sesMessageId: 'ses-1' }))
  }
  const messageProducer: MessageProducerPort = { publish: vi.fn().mockResolvedValue(success(undefined)) }

  const useCase = new SendEmailUseCase(dedupClaim, rateLimiter, emailSender, messageProducer)

  return { useCase, dedupClaim, rateLimiter, emailSender, messageProducer }
}

describe('SendEmailUseCase', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends and publishes email.status.updated with status=sent on success', async () => {
    const { useCase, messageProducer } = buildUseCase({})

    const result = await useCase.execute(BASE_INPUT)

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.outcome).toBe('sent')
    }
    expect(messageProducer.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EMAIL_STATUS_UPDATED_TOPIC,
        message: expect.objectContaining({
          payload: { emailId: 'email-1', status: 'sent', sesMessageId: 'ses-1' }
        })
      })
    )
  })

  it('skips silently when the dedup claim was already taken', async () => {
    const { useCase, emailSender } = buildUseCase({ claimed: false })

    const result = await useCase.execute(BASE_INPUT)

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.outcome).toBe('skipped-duplicate')
    }
    expect(emailSender.send).not.toHaveBeenCalled()
  })

  it('schedules a retry when the rate limit is exceeded, at attempt+1', async () => {
    const { useCase, messageProducer } = buildUseCase({ allowed: false })

    const result = await useCase.execute(BASE_INPUT)

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.outcome).toBe('retry-scheduled')
    }
    expect(messageProducer.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EMAIL_SEND_REQUESTED_RETRY_TOPIC,
        headers: { attempt: '1', nextAttemptAt: '2026-08-02T12:00:10.000Z' }
      })
    )
  })

  it('schedules a retry when SES send fails and attempt has not exhausted retries', async () => {
    const { useCase, messageProducer } = buildUseCase({ sendResult: 'failure' })

    const result = await useCase.execute({ ...BASE_INPUT, attempt: 2 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.outcome).toBe('retry-scheduled')
    }
    expect(messageProducer.publish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: EMAIL_SEND_REQUESTED_RETRY_TOPIC, headers: expect.objectContaining({ attempt: '3' }) })
    )
  })

  it('gives up, publishes status=failed, and routes to the DLQ once retries are exhausted', async () => {
    const { useCase, messageProducer } = buildUseCase({ sendResult: 'failure' })

    const result = await useCase.execute({ ...BASE_INPUT, attempt: 3 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.outcome).toBe('exhausted')
    }
    expect(messageProducer.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EMAIL_STATUS_UPDATED_TOPIC,
        message: expect.objectContaining({ payload: expect.objectContaining({ emailId: 'email-1', status: 'failed' }) })
      })
    )
    expect(messageProducer.publish).toHaveBeenCalledWith(expect.objectContaining({ topic: EMAIL_SEND_REQUESTED_DLQ_TOPIC }))
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ruguin/dispatch-worker test`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/email/application/use-cases/send-email.use-case.ts`**

```ts
import { randomUUID } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'
import { EMAIL_SEND_REQUESTED_DLQ_TOPIC, EMAIL_SEND_REQUESTED_RETRY_TOPIC, EMAIL_STATUS_UPDATED_TOPIC } from '@ruguin/event-schemas'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '@ruguin/message-broker'
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either, failure, success } from '@ruguin/utils'

import { DEDUP_CLAIM_PROVIDER, type DedupClaimPort } from '../providers/dedup-claim.port.ts'
import { EMAIL_SENDER_PROVIDER, type EmailSenderPort } from '../providers/email-sender.port.ts'
import { RATE_LIMITER_PROVIDER, type RateLimiterPort } from '../providers/rate-limiter.port.ts'
import { computeNextRetryAt, hasExhaustedRetries } from '../retry-backoff.ts'

const DEDUP_CLAIM_TTL_MS = 60_000
const SES_RATE_LIMIT_KEY = 'ses-account'
const SES_RATE_LIMIT_PER_SECOND = 14

export type SendEmailUseCaseInput = Readonly<{
  emailId: string
  from: string
  to: string
  subject: string
  html: string
  attempt: number
}>

export type SendEmailUseCaseOutput = Readonly<{
  outcome: 'sent' | 'skipped-duplicate' | 'retry-scheduled' | 'exhausted'
}>

@Injectable()
export class SendEmailUseCase {
  constructor(
    @Inject(DEDUP_CLAIM_PROVIDER) private readonly dedupClaim: DedupClaimPort,
    @Inject(RATE_LIMITER_PROVIDER) private readonly rateLimiter: RateLimiterPort,
    @Inject(EMAIL_SENDER_PROVIDER) private readonly emailSender: EmailSenderPort,
    @Inject(MESSAGE_PRODUCER_PORT) private readonly messageProducer: MessageProducerPort
  ) {}

  public async execute(input: SendEmailUseCaseInput): Promise<Either<BaseError, SendEmailUseCaseOutput>> {
    const claimed = await this.dedupClaim.claim({ key: `${input.emailId}:${input.attempt}`, ttlInMs: DEDUP_CLAIM_TTL_MS })
    if (claimed.isFailure()) return failure(claimed.value)
    if (!claimed.value.claimed) return success({ outcome: 'skipped-duplicate' })

    const rateLimit = await this.rateLimiter.check({
      key: SES_RATE_LIMIT_KEY,
      limit: SES_RATE_LIMIT_PER_SECOND,
      windowInMs: 1000
    })
    if (rateLimit.isFailure()) return failure(rateLimit.value)
    if (!rateLimit.value.allowed) return this.scheduleRetryOrGiveUp(input)

    const sent = await this.emailSender.send({ from: input.from, to: input.to, subject: input.subject, html: input.html })

    if (sent.isSuccess()) {
      const published = await this.publishStatusUpdated(input.emailId, 'sent', sent.value.sesMessageId)
      if (published.isFailure()) return failure(published.value)

      return success({ outcome: 'sent' })
    }

    return this.scheduleRetryOrGiveUp(input)
  }

  private async scheduleRetryOrGiveUp(input: SendEmailUseCaseInput): Promise<Either<BaseError, SendEmailUseCaseOutput>> {
    const nextAttempt = input.attempt + 1

    if (hasExhaustedRetries(nextAttempt)) {
      const publishedFailed = await this.publishStatusUpdated(input.emailId, 'failed')
      if (publishedFailed.isFailure()) return failure(publishedFailed.value)

      const publishedDlq = await this.messageProducer.publish({
        topic: EMAIL_SEND_REQUESTED_DLQ_TOPIC,
        key: input.emailId,
        message: { eventId: randomUUID(), name: 'email.send.requested', payload: input }
      })
      if (publishedDlq.isFailure()) return failure(publishedDlq.value)

      return success({ outcome: 'exhausted' })
    }

    const nextAttemptAt = computeNextRetryAt(nextAttempt)

    const publishedRetry = await this.messageProducer.publish({
      topic: EMAIL_SEND_REQUESTED_RETRY_TOPIC,
      key: input.emailId,
      message: { eventId: randomUUID(), name: 'email.send.requested', payload: input },
      headers: { attempt: String(nextAttempt), nextAttemptAt: nextAttemptAt.toISOString() }
    })
    if (publishedRetry.isFailure()) return failure(publishedRetry.value)

    return success({ outcome: 'retry-scheduled' })
  }

  private async publishStatusUpdated(
    emailId: string,
    status: 'sent' | 'failed',
    sesMessageId?: string
  ): Promise<Either<BaseError, void>> {
    return this.messageProducer.publish({
      topic: EMAIL_STATUS_UPDATED_TOPIC,
      key: emailId,
      message: {
        eventId: randomUUID(),
        name: 'email.status.updated',
        payload: { emailId, status, ...(sesMessageId !== undefined && { sesMessageId }) }
      }
    })
  }
}
```

- [ ] **Step 4: Run tests again**

Run: `pnpm --filter @ruguin/dispatch-worker test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dispatch-worker
git commit -m "feat(dispatch-worker): add SendEmailUseCase orchestrating claim, rate limit, SES, and retry"
```

---

### Task 16: Main consumer — `email.send.requested`

**Files:**

- Create: `apps/dispatch-worker/src/email/consumers/email-send-requested.consumer.ts`
- Create: `apps/dispatch-worker/src/email/email.module.ts`
- Create: `apps/dispatch-worker/src/shared/infrastructure/message-broker/message-broker-module-options.ts`
- Modify: `apps/dispatch-worker/src/app.module.ts`
- Modify: `apps/dispatch-worker/package.json`
- Test: `apps/dispatch-worker/src/email/consumers/__tests__/email-send-requested.consumer.int.ts`

**Interfaces:**

- Consumes: `SendEmailUseCase` (Task 15), `MessageConsumerPort`, `MessageBrokerModule` (`@ruguin/message-broker`), `EmailSendRequestedPayloadSchema`, `EMAIL_SEND_REQUESTED_TOPIC` (`@ruguin/event-schemas`).
- Produces: `MAIN_CONSUMER_GROUP_ID` (`'dispatch-worker'`), `class EmailSendRequestedConsumer` (`onModuleInit` subscribes) — the app now actually consumes Kafka.

- [ ] **Step 1: Add `@ruguin/event-schemas` and `@ruguin/message-broker` to `package.json` dependencies**

(Already present in Task 8's `package.json` — confirm they're there; skip if so.)

- [ ] **Step 2: Create `src/shared/infrastructure/message-broker/message-broker-module-options.ts`**

```ts
import { type MessageBrokerModuleOptions } from '@ruguin/message-broker'
import { messageBrokerENV } from '@ruguin/env'

export function createMessageBrokerModuleOptions(): MessageBrokerModuleOptions {
  return {
    brokers: messageBrokerENV.KAFKA_BOOTSTRAP_BROKERS.split(','),
    clientId: messageBrokerENV.KAFKA_CLIENT_ID,
    ssl: messageBrokerENV.KAFKA_SSL
  }
}
```

- [ ] **Step 3: Start the local stack (needed for this task's integration test)**

Run: `pnpm infra:up`
Expected: `kafka`, `redis` healthy.

- [ ] **Step 4: Write the failing integration test**

```ts
// apps/dispatch-worker/src/email/consumers/__tests__/email-send-requested.consumer.int.ts
import { Test } from '@nestjs/testing'
import { describe, expect, it, vi } from 'vitest'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '@ruguin/message-broker'
import { EMAIL_SEND_REQUESTED_TOPIC } from '@ruguin/event-schemas'

import { EmailModule } from '../../email.module.ts'

describe('EmailSendRequestedConsumer (real Kafka + Redis)', () => {
  it('consumes email.send.requested and eventually publishes email.status.updated', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [EmailModule] }).compile()
    await moduleRef.init()

    const producer = moduleRef.get<MessageProducerPort>(MESSAGE_PRODUCER_PORT)
    const publishSpy = vi.spyOn(producer, 'publish')

    await producer.publish({
      topic: EMAIL_SEND_REQUESTED_TOPIC,
      key: 'int-test-email-1',
      message: {
        eventId: 'evt-int-1',
        name: 'email.send.requested',
        payload: {
          emailId: 'int-test-email-1',
          from: 'sender@ruguin.dev',
          to: 'recipient@ruguin.dev',
          subject: 'Integration test',
          html: '<p>hi</p>',
          attempt: 0
        }
      }
    })

    await vi.waitUntil(
      () => publishSpy.mock.calls.some(([call]) => call.topic === 'email.status.updated'),
      { timeout: 15_000, interval: 200 }
    )

    await moduleRef.close()
  }, 20_000)
})
```

This test requires LocalStack SES running and reachable (it exercises the full path through `SesEmailSender`) — `pnpm infra:up` from Step 3 already starts it.

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm --filter @ruguin/dispatch-worker test:integration`
Expected: FAIL — `EmailModule` not found.

- [ ] **Step 6: Create `src/email/consumers/email-send-requested.consumer.ts`**

```ts
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common'
import { EMAIL_SEND_REQUESTED_TOPIC, EmailSendRequestedPayloadSchema } from '@ruguin/event-schemas'
import { MESSAGE_CONSUMER_PORT, type MessageConsumerPort } from '@ruguin/message-broker'
import { failure, success } from '@ruguin/utils'

import { SendEmailUseCase } from '../application/use-cases/send-email.use-case.ts'

export const MAIN_CONSUMER_GROUP_ID = 'dispatch-worker'

@Injectable()
export class EmailSendRequestedConsumer implements OnModuleInit {
  constructor(
    @Inject(MESSAGE_CONSUMER_PORT) private readonly consumer: MessageConsumerPort,
    private readonly sendEmail: SendEmailUseCase
  ) {}

  public async onModuleInit(): Promise<void> {
    await this.consumer.subscribe({
      topic: EMAIL_SEND_REQUESTED_TOPIC,
      groupId: MAIN_CONSUMER_GROUP_ID,
      onMessage: async (message) => {
        const parsed = EmailSendRequestedPayloadSchema.safeParse(message.payload)
        if (!parsed.success) return success(undefined)

        const result = await this.sendEmail.execute({ ...parsed.data, attempt: 0 })
        if (result.isFailure()) return failure(result.value)

        return success(undefined)
      }
    })
  }
}
```

Malformed messages (schema validation failure) resolve as `success(undefined)` here rather than `failure(...)` — KafkaJS's `eachMessage` has no built-in per-message DLQ redirection, and this plan intentionally scopes malformed-message-to-DLQ handling out (see Decisões em aberto in the design spec); a message that fails schema validation is acknowledged and dropped rather than retried forever.

- [ ] **Step 7: Create `src/email/email.module.ts`**

```ts
import { Module } from '@nestjs/common'
import { CacheModule } from '@ruguin/cache'
import { cacheENV } from '@ruguin/env'
import { MessageBrokerModule } from '@ruguin/message-broker'

import { createMessageBrokerModuleOptions } from '../shared/infrastructure/message-broker/message-broker-module-options.ts'

import { SendEmailUseCase } from './application/use-cases/send-email.use-case.ts'
import { EmailSendRequestedConsumer } from './consumers/email-send-requested.consumer.ts'
import { DEDUP_CLAIM_PROVIDER } from './application/providers/dedup-claim.port.ts'
import { EMAIL_SENDER_PROVIDER } from './application/providers/email-sender.port.ts'
import { RATE_LIMITER_PROVIDER } from './application/providers/rate-limiter.port.ts'
import { RedisDedupClaim } from './infra/redis/redis-dedup-claim.ts'
import { RedisRateLimiter } from './infra/redis/redis-rate-limiter.ts'
import { SesEmailSender } from './infra/ses/ses-email-sender.ts'
import { SES_CLIENT_PROVIDER, sesClientProvider } from './infra/ses/ses-client.provider.ts'

@Module({
  imports: [
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
    MessageBrokerModule.forRoot({ isGlobal: true, ...createMessageBrokerModuleOptions() })
  ],
  providers: [
    sesClientProvider,
    { provide: DEDUP_CLAIM_PROVIDER, useClass: RedisDedupClaim },
    { provide: RATE_LIMITER_PROVIDER, useClass: RedisRateLimiter },
    { provide: EMAIL_SENDER_PROVIDER, useClass: SesEmailSender },
    SendEmailUseCase,
    EmailSendRequestedConsumer
  ]
})
export class EmailModule {}
```

This references `ses-client.provider.ts`, not yet created — Step 8 adds it (the `SesEmailSender` from Task 13 takes a raw `SESClient` in its constructor, so something in this module must construct and provide one).

- [ ] **Step 8: Create `src/email/infra/ses/ses-client.provider.ts`**

```ts
import { type Provider } from '@nestjs/common'
import { SESClient } from '@aws-sdk/client-ses'
import { awsENV } from '@ruguin/env'

export const SES_CLIENT_PROVIDER = SESClient

export const sesClientProvider: Provider = {
  provide: SESClient,
  useFactory: (): SESClient =>
    new SESClient({
      region: awsENV.AWS_REGION,
      ...(awsENV.AWS_ENDPOINT_URL !== undefined && { endpoint: awsENV.AWS_ENDPOINT_URL }),
      credentials: { accessKeyId: awsENV.AWS_ACCESS_KEY_ID, secretAccessKey: awsENV.AWS_SECRET_ACCESS_KEY }
    })
}
```

- [ ] **Step 9: Update `src/email/email.module.ts`'s import of `SES_CLIENT_PROVIDER`**

Remove the unused `SES_CLIENT_PROVIDER` import (only `sesClientProvider` is used as a provider entry):

```ts
import { sesClientProvider } from './infra/ses/ses-client.provider.ts'
```

- [ ] **Step 10: Wire `EmailModule` into `app.module.ts`**

```ts
import { Module } from '@nestjs/common'

import { EmailModule } from './email/email.module.ts'
import { HealthModule } from './health/health.module.ts'

@Module({
  imports: [EmailModule, HealthModule],
  controllers: [],
  providers: []
})
export class AppModule {}
```

`CacheModule`/`MessageBrokerModule` move from directly inside `AppModule` (Task 8) to inside `EmailModule` — since `EmailModule` is `isGlobal: true` for both, `HealthModule`'s `CacheHealthIndicator` still resolves `ICacheProvider` correctly as long as `EmailModule` is imported before or alongside `HealthModule` in the same `AppModule`.

- [ ] **Step 11: Run the integration test**

Run: `pnpm --filter @ruguin/dispatch-worker test:integration`
Expected: PASS — publishing to `email.send.requested` results in a `email.status.updated` publish within 15s (LocalStack SES accepts any well-formed send).

- [ ] **Step 12: Run the full unit + e2e suite too**

Run: `pnpm --filter @ruguin/dispatch-worker test && pnpm --filter @ruguin/dispatch-worker test:e2e`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add apps/dispatch-worker
git commit -m "feat(dispatch-worker): wire the main email.send.requested consumer end to end"
```

---

### Task 17: Retry consumer — `email.send.requested.retry`

**Files:**

- Create: `apps/dispatch-worker/src/email/consumers/email-send-requested-retry.consumer.ts`
- Modify: `apps/dispatch-worker/src/email/email.module.ts`
- Test: `apps/dispatch-worker/src/email/consumers/__tests__/email-send-requested-retry.consumer.unit.ts`

**Interfaces:**

- Consumes: `SendEmailUseCase` (Task 15), `MessageConsumerPort` (`@ruguin/message-broker`), `EmailSendRequestedPayloadSchema`, `EMAIL_SEND_REQUESTED_RETRY_TOPIC` (`@ruguin/event-schemas`).
- Produces: `RETRY_CONSUMER_GROUP_ID` (`'dispatch-worker-retry'`), `class EmailSendRequestedRetryConsumer`.

- [ ] **Step 1: Write the failing unit test**

Unit-level (not integration) — this test exercises the wait-until-due + attempt-parsing logic directly against a fake `MessageConsumerPort`, without a real broker.

```ts
// apps/dispatch-worker/src/email/consumers/__tests__/email-send-requested-retry.consumer.unit.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type MessageConsumerPort, type SubscribeInput } from '@ruguin/message-broker'
import { success } from '@ruguin/utils'

import { type SendEmailUseCase } from '../../application/use-cases/send-email.use-case.ts'
import { EmailSendRequestedRetryConsumer, RETRY_CONSUMER_GROUP_ID } from '../email-send-requested-retry.consumer.ts'

describe('EmailSendRequestedRetryConsumer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes to the retry topic under its own consumer group', async () => {
    let subscribeInput: SubscribeInput | undefined
    const fakeConsumer: MessageConsumerPort = {
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput) => {
        subscribeInput = input
        return success(undefined)
      })
    }
    const sendEmail = { execute: vi.fn().mockResolvedValue(success({ outcome: 'sent' })) } as unknown as SendEmailUseCase

    await new EmailSendRequestedRetryConsumer(fakeConsumer, sendEmail).onModuleInit()

    expect(subscribeInput?.topic).toBe('email.send.requested.retry')
    expect(subscribeInput?.groupId).toBe(RETRY_CONSUMER_GROUP_ID)
  })

  it('waits until nextAttemptAt before calling the use case, then passes the header attempt through', async () => {
    let onMessage: SubscribeInput['onMessage'] = async () => success(undefined)
    const fakeConsumer: MessageConsumerPort = {
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput) => {
        onMessage = input.onMessage
        return success(undefined)
      })
    }
    const sendEmail = { execute: vi.fn().mockResolvedValue(success({ outcome: 'sent' })) } as unknown as SendEmailUseCase

    await new EmailSendRequestedRetryConsumer(fakeConsumer, sendEmail).onModuleInit()

    const messagePromise = onMessage({
      eventId: 'evt-1',
      name: 'email.send.requested',
      payload: { emailId: 'email-1', from: 'a@ruguin.dev', to: 'b@ruguin.dev', subject: 'Hi', html: '<p>Hi</p>' },
      headers: { attempt: '1', nextAttemptAt: '2026-08-02T12:00:10.000Z' }
    })

    await vi.advanceTimersByTimeAsync(10_000)
    await messagePromise

    expect(sendEmail.execute).toHaveBeenCalledWith(
      expect.objectContaining({ emailId: 'email-1', attempt: 1 })
    )
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ruguin/dispatch-worker test`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/email/consumers/email-send-requested-retry.consumer.ts`**

```ts
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common'
import { EMAIL_SEND_REQUESTED_RETRY_TOPIC, EmailSendRequestedPayloadSchema } from '@ruguin/event-schemas'
import { MESSAGE_CONSUMER_PORT, type MessageConsumerPort } from '@ruguin/message-broker'
import { failure, success } from '@ruguin/utils'

import { SendEmailUseCase } from '../application/use-cases/send-email.use-case.ts'

export const RETRY_CONSUMER_GROUP_ID = 'dispatch-worker-retry'

function waitUntil(dueAt: Date): Promise<void> {
  const waitMs = Math.max(0, dueAt.getTime() - Date.now())
  return new Promise((resolve) => setTimeout(resolve, waitMs))
}

@Injectable()
export class EmailSendRequestedRetryConsumer implements OnModuleInit {
  constructor(
    @Inject(MESSAGE_CONSUMER_PORT) private readonly consumer: MessageConsumerPort,
    private readonly sendEmail: SendEmailUseCase
  ) {}

  public async onModuleInit(): Promise<void> {
    await this.consumer.subscribe({
      topic: EMAIL_SEND_REQUESTED_RETRY_TOPIC,
      groupId: RETRY_CONSUMER_GROUP_ID,
      onMessage: async (message) => {
        const parsed = EmailSendRequestedPayloadSchema.safeParse(message.payload)
        if (!parsed.success) return success(undefined)

        const attempt = Number(message.headers.attempt ?? '0')
        const nextAttemptAt = new Date(message.headers.nextAttemptAt ?? new Date().toISOString())

        await waitUntil(nextAttemptAt)

        const result = await this.sendEmail.execute({ ...parsed.data, attempt })
        if (result.isFailure()) return failure(result.value)

        return success(undefined)
      }
    })
  }
}
```

This retry consumer runs as its own consumer group (separate from `MAIN_CONSUMER_GROUP_ID`), so a wait here never delays the main topic's throughput — matching the design spec's rationale for choosing a dedicated retry topic.

- [ ] **Step 4: Add `EmailSendRequestedRetryConsumer` to `src/email/email.module.ts`'s providers**

```ts
providers: [
  sesClientProvider,
  { provide: DEDUP_CLAIM_PROVIDER, useClass: RedisDedupClaim },
  { provide: RATE_LIMITER_PROVIDER, useClass: RedisRateLimiter },
  { provide: EMAIL_SENDER_PROVIDER, useClass: SesEmailSender },
  SendEmailUseCase,
  EmailSendRequestedConsumer,
  EmailSendRequestedRetryConsumer
]
```

(add the corresponding import: `import { EmailSendRequestedRetryConsumer } from './consumers/email-send-requested-retry.consumer.ts'`)

- [ ] **Step 5: Run tests again**

Run: `pnpm --filter @ruguin/dispatch-worker test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/dispatch-worker
git commit -m "feat(dispatch-worker): wire the email.send.requested.retry consumer"
```

---

### Task 18: End-to-end test — success path and exhausted-retry-to-DLQ path

**Files:**

- Test: `apps/dispatch-worker/src/email/__tests__/dispatch-email.e2e.ts`

**Interfaces:**

- Consumes: `EmailModule` (Task 16/17), `MessageProducerPort`/`MessageConsumerPort` (`@ruguin/message-broker`).

- [ ] **Step 1: Confirm the local stack is up**

Run: `pnpm infra:up`
Expected: `kafka`, `redis`, `localstack` healthy.

- [ ] **Step 2: Write the e2e test**

```ts
// apps/dispatch-worker/src/email/__tests__/dispatch-email.e2e.ts
import { Test, type TestingModule } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  EMAIL_SEND_REQUESTED_DLQ_TOPIC,
  EMAIL_SEND_REQUESTED_TOPIC,
  EMAIL_STATUS_UPDATED_TOPIC
} from '@ruguin/event-schemas'
import { MESSAGE_CONSUMER_PORT, MESSAGE_PRODUCER_PORT, type MessageConsumerPort, type MessageProducerPort } from '@ruguin/message-broker'

import { EmailModule } from '../email.module.ts'

describe('Dispatch Worker end to end', () => {
  let producer: MessageProducerPort
  let consumer: MessageConsumerPort
  let moduleRef: TestingModule

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [EmailModule] }).compile()
    await moduleRef.init()

    producer = moduleRef.get<MessageProducerPort>(MESSAGE_PRODUCER_PORT)
    consumer = moduleRef.get<MessageConsumerPort>(MESSAGE_CONSUMER_PORT)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  it('sends a well-formed email and publishes email.status.updated with status=sent', async () => {
    const statusEvents: unknown[] = []
    await consumer.subscribe({
      topic: EMAIL_STATUS_UPDATED_TOPIC,
      groupId: `e2e-status-${Date.now()}`,
      onMessage: async (message) => {
        statusEvents.push(message.payload)
        return { isFailure: () => false, isSuccess: () => true, value: undefined } as never
      }
    })

    await producer.publish({
      topic: EMAIL_SEND_REQUESTED_TOPIC,
      key: 'e2e-success',
      message: {
        eventId: 'evt-e2e-1',
        name: 'email.send.requested',
        payload: {
          emailId: 'e2e-success',
          from: 'sender@ruguin.dev',
          to: 'recipient@ruguin.dev',
          subject: 'E2E success',
          html: '<p>hi</p>',
          attempt: 0
        }
      }
    })

    await vi.waitUntil(
      () => statusEvents.some((event) => (event as { emailId: string }).emailId === 'e2e-success'),
      { timeout: 15_000, interval: 200 }
    )

    expect(statusEvents).toContainEqual(expect.objectContaining({ emailId: 'e2e-success', status: 'sent' }))
  }, 20_000)

  it('exhausts retries and routes to the DLQ when the "to" address is malformed at the SES layer', async () => {
    const dlqMessages: unknown[] = []
    await consumer.subscribe({
      topic: EMAIL_SEND_REQUESTED_DLQ_TOPIC,
      groupId: `e2e-dlq-${Date.now()}`,
      onMessage: async (message) => {
        dlqMessages.push(message.payload)
        return { isFailure: () => false, isSuccess: () => true, value: undefined } as never
      }
    })

    await producer.publish({
      topic: EMAIL_SEND_REQUESTED_TOPIC,
      key: 'e2e-failure',
      message: {
        eventId: 'evt-e2e-2',
        name: 'email.send.requested',
        payload: {
          emailId: 'e2e-failure',
          from: 'sender@ruguin.dev',
          to: 'not-a-valid-address',
          subject: 'E2E failure',
          html: '<p>hi</p>',
          attempt: 0
        }
      }
    })

    await vi.waitUntil(
      () => dlqMessages.some((message) => (message as { emailId: string }).emailId === 'e2e-failure'),
      { timeout: 60_000, interval: 500 }
    )

    expect(dlqMessages).toContainEqual(expect.objectContaining({ emailId: 'e2e-failure' }))
  }, 70_000)
})
```

The failure path relies on LocalStack SES rejecting `to: 'not-a-valid-address'` as a synchronous SDK error on every attempt (main + 3 retries), and needs the full ~70s of backoff (10s+20s+40s) to play out — hence the long timeout.

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @ruguin/dispatch-worker test:e2e`
Expected: FAIL — `dispatch-email.e2e.ts` doesn't compile yet if `EmailModule`/ports aren't fully wired (should already pass compilation from Task 17; if it fails here it's a real regression to fix, not an expected initial failure — treat this step as a smoke check for Steps 1-2's file, not a strict red step, since all the underlying pieces already exist from Tasks 15-17).

- [ ] **Step 4: Run it for real and fix any issues found**

Run: `pnpm --filter @ruguin/dispatch-worker test:e2e`
Expected: PASS — both scenarios green. If the success case times out, check `pnpm infra:up` brought up `localstack` with `SERVICES: ses` healthy. If the failure case times out short of 70s, check `computeNextRetryAt`'s `BASE_BACKOFF_MS` matches Task 14's `5000`.

- [ ] **Step 5: Run the full test suite one more time across all three packages/app**

Run: `pnpm --filter @ruguin/event-schemas test:all && pnpm --filter @ruguin/message-broker test:all && pnpm --filter @ruguin/dispatch-worker test:all`
Expected: PASS across the board.

- [ ] **Step 6: Run the repo-wide checks**

Run: `pnpm run check`
Expected: types, lint, format, and spelling all pass. Fix any issues surfaced (new files commonly trip spelling on domain terms — add to `.cspell.json` if a real word gets flagged).

- [ ] **Step 7: Commit**

```bash
git add apps/dispatch-worker
git commit -m "test(dispatch-worker): add end-to-end coverage for the success and exhausted-retry-to-DLQ paths"
```

---

## Self-Review Notes

- **Spec coverage:** every numbered section of `docs/superpowers/specs/2026-08-02-dispatch-worker-design.md` maps to a task — `event-schemas` (Tasks 1–3), `message-broker` producer/consumer/module (Tasks 4–7), core-server rewiring (Task 9), `dispatch-worker` scaffold/health (Task 8), rate limit + idempotency (Tasks 11–12), SES (Task 13), retry queue + DLQ (Tasks 14–15, 17), main consumer (Task 16), end-to-end (Task 18).
- **Type consistency:** `SendEmailUseCaseInput`/`Output` (Task 15) match what Task 16/17's consumers pass in (`{ ...parsed.data, attempt }`) and read out (`result.value.outcome`). `OutboundMessage`'s `headers?` field (Task 4) is the same optional field `KafkaMessageProducer` (Task 5) and `SendEmailUseCase` (Task 15) both read/write. Topic constant names used across Tasks 15–18 (`EMAIL_SEND_REQUESTED_TOPIC`, `_RETRY_TOPIC`, `_DLQ_TOPIC`, `EMAIL_STATUS_UPDATED_TOPIC`) all resolve to the single definitions in Tasks 1–2 — no ad hoc string literals for topic names anywhere outside `packages/event-schemas`.
- **No placeholders:** every step above contains literal, complete code — no `TODO`/`add error handling`/"similar to Task N" shortcuts.
