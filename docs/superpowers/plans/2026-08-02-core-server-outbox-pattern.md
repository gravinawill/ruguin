# Core Server — Outbox Pattern Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the transactional outbox infrastructure for `apps/core-server` — a generic
`Event<T>` in the kernel, a single partitioned `OutboxMessage` table with a port per module, and a
relay that publishes with guaranteed per-`(module, key)` ordering — so that a future business module
can enqueue a domain event in the same transaction as its write and trust it reaches Kafka
at-least-once.

**Architecture:** `Event<T>` (new, in `packages/ddd-kernel`) is a generic envelope a module wraps its
payload DTO in. `OutboxRepository` (new, in `apps/core-server/src/shared/outbox/`) implements the
shared `OutboxPort` contract, scoped to one module name per instance, and writes through the
`TransactionContext` the existing `TransactionManager` already provides. `OutboxRelayService` polls
`PENDING` rows with a window-function query that always exposes the oldest row of each
`(module, key)`, locks with `FOR UPDATE SKIP LOCKED`, and publishes through `MessageProducerPort` — a
fake in-memory implementation in this plan, a real Kafka producer in a future one.
`OutboxPartitionMaintenanceService` keeps the table's monthly `RANGE` partitions ahead of the current
date and drops old, fully-terminal ones.

**Tech Stack:** NestJS 11, Prisma 7 (`@prisma/adapter-pg`), PostgreSQL (`RANGE` partitioning),
`@nestjs/schedule` (new dependency), Vitest (`unit`/`integration`/`e2e` projects), `@ruguin/utils`
(`Either`), `@ruguin/ddd-kernel` (`BaseError`, `ID`).

## Global Constraints

- Toda falha esperada devolve `Either`; `throw` é só para bug (ex.: falha de `ID.generate()`, que na
  prática nunca acontece para UUID v7).
- Anote sempre o tipo de retorno de uma função que devolve `Either` — `success(x)` sozinho infere
  `Either<unknown, X>` e não encaixa onde se espera `Either<BaseError, X>`.
- Contract nunca menciona o Prisma; só o adapter em `infra`/`shared/outbox` casta
  `TransactionContext` para `Prisma.TransactionClient`.
- Repositórios traduzem erro de infraestrutura em erro de domínio (nunca deixam `Prisma.*` vazar).
- Testes em `__tests__/` ao lado do código: `*.unit.ts` (sem I/O), `*.int.ts` (Postgres real via
  `pnpm infra:up`).
- Manter arquivos abaixo de 500 linhas.
- Nenhuma feature de domínio é criada neste plano — nenhum módulo de negócio existe ainda em
  `apps/core-server/src/`.

---

### Task 1: `Event<T>` no `ddd-kernel`

**Files:**
- Create: `packages/ddd-kernel/src/event.ts`
- Create: `packages/ddd-kernel/src/__tests__/event.unit.ts`
- Modify: `packages/ddd-kernel/src/index.ts`

**Interfaces:**
- Consumes: `ID` (`packages/ddd-kernel/src/value-objects/id/id.value-object.ts`) — `ID.generate(input:
  {valueObjectName: string}): Either<GenerateIDError, {idGenerated: ID}>`.
- Produces: `Event<TPayload>` — `readonly id: ID`, `readonly name: string`, `readonly payload:
  TPayload`, `readonly occurredAt: Date`; static `Event.create<TPayload>(name: string, payload:
  TPayload): Event<TPayload>`. Every later task that enqueues a message constructs one of these.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ddd-kernel/src/__tests__/event.unit.ts
import { describe, expect, it } from 'vitest'

import { Event } from '../event.ts'
import { ID } from '../value-objects/index.ts'

type SamplePayload = { reason: string }

describe('Event.create', () => {
  it('produces an event with a generated id, the given name and payload', () => {
    const event = Event.create<SamplePayload>('health.degraded', { reason: 'timeout' })

    expect(event.name).toBe('health.degraded')
    expect(event.payload).toEqual({ reason: 'timeout' })
    expect(event.id).toBeInstanceOf(ID)
  })

  it('stamps occurredAt with the creation time', () => {
    const before = new Date()
    const event = Event.create<SamplePayload>('health.degraded', { reason: 'timeout' })
    const after = new Date()

    expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(event.occurredAt.getTime()).toBeLessThanOrEqual(after.getTime())
  })

  it('generates a distinct id for every call, even with identical name and payload', () => {
    const first = Event.create<SamplePayload>('health.degraded', { reason: 'timeout' })
    const second = Event.create<SamplePayload>('health.degraded', { reason: 'timeout' })

    expect(first.id.equals({ otherID: second.id })).toBe(false)
  })

  it('produces an id that satisfies ID.validate', () => {
    const event = Event.create<SamplePayload>('health.degraded', { reason: 'timeout' })

    const validated = ID.validate({ id: event.id.toString(), valueObjectName: 'Event' })

    expect(validated.isSuccess()).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ruguin/ddd-kernel test:unit`
Expected: FAIL — `../event.ts` does not exist yet.

- [ ] **Step 3: Implement `Event<T>`**

```ts
// packages/ddd-kernel/src/event.ts
import { ID } from './value-objects/index.ts'

export class Event<TPayload> {
  readonly id: ID
  readonly name: string
  readonly payload: TPayload
  readonly occurredAt: Date

  private constructor(input: { id: ID; name: string; payload: TPayload; occurredAt: Date }) {
    this.id = input.id
    this.name = input.name
    this.payload = input.payload
    this.occurredAt = input.occurredAt
    Object.freeze(this)
  }

  public static create<TPayload>(name: string, payload: TPayload): Event<TPayload> {
    const generated = ID.generate({ valueObjectName: 'Event' })

    // ID.generate() only fails if UUID generation itself throws, which does not happen in
    // practice — treated as a bug rather than an expected Either failure.
    if (generated.isFailure()) {
      throw new Error(`Failed to generate an id for event "${name}": ${generated.value.message}`)
    }

    return new Event({ id: generated.value.idGenerated, name, occurredAt: new Date(), payload })
  }
}
```

- [ ] **Step 4: Export `Event` from the package barrel**

```ts
// packages/ddd-kernel/src/index.ts
export * from './enums/index.ts'
export * from './errors/index.ts'
export * from './event.ts'
export * from './value-objects/index.ts'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @ruguin/ddd-kernel test:unit`
Expected: PASS (all 4 cases)

- [ ] **Step 6: Type-check the package**

Run: `pnpm --filter @ruguin/ddd-kernel check:types`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add packages/ddd-kernel/src/event.ts packages/ddd-kernel/src/__tests__/event.unit.ts packages/ddd-kernel/src/index.ts
git commit -m "feat(ddd-kernel): add generic Event<T> envelope"
```

---

### Task 2: Partitioned `OutboxMessage` schema

**Files:**
- Modify: `apps/core-server/prisma/schema/outbox.prisma`
- Create: `apps/core-server/prisma/migrations/<timestamp>_add_outbox_partitioning/migration.sql`
  (timestamp assigned by the `prisma migrate dev --create-only` command in Step 2)

**Interfaces:**
- Produces: the `outbox_messages` table with columns `id`, `eventId`, `module`, `topic`, `key`,
  `name`, `payload`, `status`, `attempts`, `nextAttemptAt`, `createdAt`, `publishedAt`, `lastError`;
  composite PK `(id, createdAt)`; composite unique `(eventId, createdAt)`; indexes
  `[status, createdAt]`, `[module, key, status, createdAt]`, `[status, publishedAt]`; `RANGE`
  partitioned by `createdAt`, with partitions for 2026-08, 2026-09 and 2026-10 already created. Every
  later task's Prisma calls (`prisma.outboxMessage.*`) and raw SQL against `outbox_messages` depend
  on this shape.

- [ ] **Step 1: Update the Prisma schema**

```prisma
// apps/core-server/prisma/schema/outbox.prisma
model OutboxMessage {
  id            String       @default(uuid(7))
  eventId       String
  module        String
  topic         String
  key           String
  name          String
  payload       Json
  status        OutboxStatus @default(PENDING)
  attempts      Int          @default(0)
  nextAttemptAt DateTime?
  createdAt     DateTime     @default(now())
  publishedAt   DateTime?
  lastError     String?

  @@id([id, createdAt])
  @@unique([eventId, createdAt])
  @@index([status, createdAt])
  @@index([module, key, status, createdAt])
  @@index([status, publishedAt])
  @@map("outbox_messages")
}

enum OutboxStatus {
  PENDING
  PUBLISHED
  FAILED
}
```

- [ ] **Step 2: Start local Postgres and scaffold an empty migration**

Run: `pnpm infra:up`
Run: `pnpm with-env pnpm --filter @ruguin/core-server exec prisma migrate dev --create-only --name add_outbox_partitioning`

Expected: a new folder `apps/core-server/prisma/migrations/<timestamp>_add_outbox_partitioning/` with
a `migration.sql` inside. Prisma's own diff cannot express `PARTITION BY`, so whatever it generated
there gets fully replaced in the next step.

- [ ] **Step 3: Replace the generated migration with the hand-written partitioned DDL**

Overwrite the `migration.sql` file created in Step 2 with:

```sql
-- Outbox becomes a partitioned table (RANGE by createdAt) with the new module/eventId/name/
-- nextAttemptAt columns. Postgres cannot ALTER an existing table into PARTITION BY, and there is no
-- data to preserve yet (no producer or consumer exists), so the table is dropped and recreated.
DROP TABLE "outbox_messages";

CREATE TABLE "outbox_messages" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_messages_eventId_createdAt_key" ON "outbox_messages"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_messages_status_createdAt_idx" ON "outbox_messages"("status", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_messages_module_key_status_createdAt_idx" ON "outbox_messages"("module", "key", "status", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_messages_status_publishedAt_idx" ON "outbox_messages"("status", "publishedAt");

-- Initial partitions: the current month plus the two following, so inserts have somewhere to land
-- immediately. OutboxPartitionMaintenanceService (Task 6) takes over creating future partitions and
-- dropping old, empty ones.
CREATE TABLE "outbox_messages_2026_08" PARTITION OF "outbox_messages"
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "outbox_messages_2026_09" PARTITION OF "outbox_messages"
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "outbox_messages_2026_10" PARTITION OF "outbox_messages"
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
```

- [ ] **Step 4: Apply the migration and regenerate the Prisma client**

Run: `pnpm with-env pnpm --filter @ruguin/core-server db:deploy`
Run: `pnpm --filter @ruguin/core-server db:generate`

Expected: both commands exit 0. `apps/core-server/src/generated/prisma/models/OutboxMessage.ts` is
regenerated with the new fields.

- [ ] **Step 5: Verify the table is actually partitioned**

Run: `docker compose -f infrastructure/local/docker-compose.yml exec postgres psql -U ruguin -d ruguin -c '\d+ core_server.outbox_messages'`

Expected: output includes `Partition key: RANGE ("createdAt")` and, under `Partitions:`, the three
tables `outbox_messages_2026_08`, `outbox_messages_2026_09`, `outbox_messages_2026_10`.

- [ ] **Step 6: Type-check the app**

Run: `pnpm --filter @ruguin/core-server check:types`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add apps/core-server/prisma/schema/outbox.prisma apps/core-server/prisma/migrations
git commit -m "feat(core-server): partition the outbox table by month and add module/eventId/name columns"
```

---

### Task 3: `OutboxPort` contract and `OutboxRepository`

**Files:**
- Create: `apps/core-server/src/shared/contracts/outbox.port.ts`
- Create: `apps/core-server/src/shared/errors/duplicate-outbox-event.error.ts`
- Create: `apps/core-server/src/shared/errors/enqueue-outbox-message.error.ts`
- Create: `apps/core-server/src/shared/outbox/outbox.repository.ts`
- Create: `apps/core-server/src/shared/outbox/__tests__/outbox.repository.unit.ts`
- Create: `apps/core-server/src/shared/outbox/__tests__/outbox-test-context.ts`
- Create: `apps/core-server/src/shared/outbox/__tests__/outbox.repository.int.ts`

**Interfaces:**
- Consumes: `Event<TPayload>` (Task 1); `TransactionContext` (`shared/contracts/transaction-context.contract.ts`); `PrismaTransactionManager` (existing) for the integration test.
- Produces: `OUTBOX_PORT` (`Symbol`) and `OutboxPort.enqueue<TPayload>(event: Event<TPayload>, options:
  {topic: string; key: string}, tx: TransactionContext): Promise<Either<DuplicateOutboxEventError |
  EnqueueOutboxMessageError, void>>`; `OutboxRepository` (constructor `(module: string)`) implementing
  it. Task 5 (relay) reads the rows this writes; Task 7 (`OutboxModule.forFeature`) constructs it.

**NOTA PÓS-IMPLEMENTAÇÃO:** `DuplicateOutboxEventError` (todas as referências abaixo) foi removido
por completo durante a execução desta task, num fix round de revisão. `@@unique([eventId,
createdAt])` (Task 2) não consegue detectar duplicata de enqueue de verdade: `createdAt` é gerado
por linha no client (não é `CURRENT_TIMESTAMP` da transação), então duas chamadas genuinamente
duplicadas quase sempre caem em `createdAt` diferentes e o índice único nunca acusa conflito — o
erro que o brief abaixo descreve é, na prática, inalcançável. A decisão final: `eventId` serve para
dedup do lado do consumer (quando o relay publica a mesma linha duas vezes após um crash entre
publish e marcar `PUBLISHED`), não para bloquear enqueue duplicado na origem. Qualquer falha do
Prisma no `enqueue` — incluindo violação de constraint única — vira `EnqueueOutboxMessageError`
genérico. O código de `duplicate-outbox-event.error.ts` e o branch de detecção de P2002 nunca
chegaram a existir na versão final; o texto abaixo é o brief original, mantido como registro
histórico do que foi tentado primeiro.

- [ ] **Step 1: Write the failing unit test**

```ts
// apps/core-server/src/shared/outbox/__tests__/outbox.repository.unit.ts
import { Event } from '@ruguin/ddd-kernel'
import { describe, expect, it } from 'vitest'

import { type TransactionContext } from '../../contracts/transaction-context.contract'
import { DuplicateOutboxEventError } from '../../errors/duplicate-outbox-event.error'
import { EnqueueOutboxMessageError } from '../../errors/enqueue-outbox-message.error'
import { OutboxRepository } from '../outbox.repository'

type CreateArgs = { data: Record<string, unknown> }

function createTransactionStub(createImpl: (args: CreateArgs) => Promise<unknown>): TransactionContext {
  return { outboxMessage: { create: createImpl } } as unknown as TransactionContext
}

describe('OutboxRepository#enqueue', () => {
  it('writes the event through the given transaction, scoped to its module', async () => {
    const calls: CreateArgs[] = []
    const tx = createTransactionStub(async (args) => {
      calls.push(args)
      return { id: 'generated-id', ...args.data }
    })
    const repository = new OutboxRepository('health')
    const event = Event.create('health.degraded', { reason: 'timeout' })

    const result = await repository.enqueue(event, { key: 'service-a', topic: 'health-events' }, tx)

    expect(result.isSuccess()).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.data).toMatchObject({
      eventId: event.id.toString(),
      key: 'service-a',
      module: 'health',
      name: 'health.degraded',
      payload: { reason: 'timeout' },
      topic: 'health-events'
    })
  })

  it('maps a unique constraint violation on eventId into DuplicateOutboxEventError', async () => {
    const tx = createTransactionStub(async () => {
      throw { code: 'P2002' }
    })
    const repository = new OutboxRepository('health')
    const event = Event.create('health.degraded', { reason: 'timeout' })

    const result = await repository.enqueue(event, { key: 'service-a', topic: 'health-events' }, tx)

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(DuplicateOutboxEventError)
  })

  it('maps any other infra failure into EnqueueOutboxMessageError', async () => {
    const tx = createTransactionStub(async () => {
      throw new Error('connection terminated unexpectedly')
    })
    const repository = new OutboxRepository('health')
    const event = Event.create('health.degraded', { reason: 'timeout' })

    const result = await repository.enqueue(event, { key: 'service-a', topic: 'health-events' }, tx)

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(EnqueueOutboxMessageError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ruguin/core-server test`
Expected: FAIL — `../outbox.repository` does not exist yet.

- [ ] **Step 3: Write the errors, the contract, and the implementation**

```ts
// apps/core-server/src/shared/errors/duplicate-outbox-event.error.ts
import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class DuplicateOutboxEventError extends BaseError {
  readonly name = 'DuplicateOutboxEventError'
  readonly status = StatusError.CONFLICT

  constructor(input: { eventId: string }) {
    super({ message: `An outbox message for event "${input.eventId}" was already enqueued.` })
  }
}
```

```ts
// apps/core-server/src/shared/errors/enqueue-outbox-message.error.ts
import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class EnqueueOutboxMessageError extends BaseError {
  readonly name = 'EnqueueOutboxMessageError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to enqueue the outbox message.' })
  }
}
```

```ts
// apps/core-server/src/shared/contracts/outbox.port.ts
import { type Event } from '@ruguin/ddd-kernel'
import { type Either } from '@ruguin/utils'

import { type DuplicateOutboxEventError } from '../errors/duplicate-outbox-event.error'
import { type EnqueueOutboxMessageError } from '../errors/enqueue-outbox-message.error'

import { type TransactionContext } from './transaction-context.contract'

export const OUTBOX_PORT = Symbol('OUTBOX_PORT')

export interface OutboxPort {
  enqueue<TPayload>(
    event: Event<TPayload>,
    options: { topic: string; key: string },
    tx: TransactionContext
  ): Promise<Either<DuplicateOutboxEventError | EnqueueOutboxMessageError, void>>
}
```

```ts
// apps/core-server/src/shared/outbox/outbox.repository.ts
import { type Event } from '@ruguin/ddd-kernel'
import { type Either, failure, success } from '@ruguin/utils'

import { type Prisma } from '../../generated/prisma/client'
import { type OutboxPort } from '../contracts/outbox.port'
import { type TransactionContext } from '../contracts/transaction-context.contract'
import { DuplicateOutboxEventError } from '../errors/duplicate-outbox-event.error'
import { EnqueueOutboxMessageError } from '../errors/enqueue-outbox-message.error'

const UNIQUE_CONSTRAINT_VIOLATION_CODE = 'P2002'

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === UNIQUE_CONSTRAINT_VIOLATION_CODE
  )
}

export class OutboxRepository implements OutboxPort {
  constructor(private readonly module: string) {}

  public async enqueue<TPayload>(
    event: Event<TPayload>,
    options: { topic: string; key: string },
    tx: TransactionContext
  ): Promise<Either<DuplicateOutboxEventError | EnqueueOutboxMessageError, void>> {
    const client = tx as unknown as Prisma.TransactionClient

    try {
      await client.outboxMessage.create({
        data: {
          eventId: event.id.toString(),
          key: options.key,
          module: this.module,
          name: event.name,
          payload: event.payload as Prisma.InputJsonValue,
          topic: options.topic
        }
      })

      return success(undefined)
    } catch (error: unknown) {
      if (isUniqueConstraintViolation(error)) {
        return failure(new DuplicateOutboxEventError({ eventId: event.id.toString() }))
      }

      return failure(new EnqueueOutboxMessageError({ error }))
    }
  }
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test`
Expected: PASS (all 3 cases)

- [ ] **Step 5: Write the integration test context helper**

```ts
// apps/core-server/src/shared/outbox/__tests__/outbox-test-context.ts
import { PrismaService } from '../../database/prisma.service'

export const TEST_DATABASE_URL: string =
  process.env.DATABASE_URL ?? 'postgresql://ruguin:ruguin@localhost:5432/ruguin?schema=core_server'

export const createTestPrismaService = (): PrismaService => new PrismaService(TEST_DATABASE_URL)

export const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
```

- [ ] **Step 6: Write the failing atomicity integration test**

```ts
// apps/core-server/src/shared/outbox/__tests__/outbox.repository.int.ts
import { BaseError, Event, StatusError } from '@ruguin/ddd-kernel'
import { failure } from '@ruguin/utils'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { PrismaTransactionManager } from '../../database/prisma-transaction-manager'
import { type PrismaService } from '../../database/prisma.service'
import { OutboxRepository } from '../outbox.repository'

import { createTestPrismaService } from './outbox-test-context'

const MODULE = 'outbox-repository-int-test'

class RollbackTestError extends BaseError {
  readonly name = 'RollbackTestError'
  readonly status = StatusError.CONFLICT

  constructor() {
    super({ message: 'forced rollback for the atomicity test' })
  }
}

const context: { prisma: PrismaService | null } = { prisma: null }

const prisma = (): PrismaService => {
  if (context.prisma === null) throw new Error('prisma was never connected')
  return context.prisma
}

beforeAll(() => {
  context.prisma = createTestPrismaService()
})

afterEach(async () => {
  await prisma().outboxMessage.deleteMany({ where: { module: MODULE } })
})

afterAll(async () => {
  await prisma().$disconnect()
})

describe('OutboxRepository against a live Postgres, inside PrismaTransactionManager', () => {
  it('persists the row when the transaction commits', async () => {
    const manager = new PrismaTransactionManager(prisma())
    const repository = new OutboxRepository(MODULE)
    const event = Event.create('test.committed', { ok: true })

    const result = await manager.execute((tx) =>
      repository.enqueue(event, { key: 'commit-case', topic: 'test-topic' }, tx)
    )

    expect(result.isSuccess()).toBe(true)

    const stored = await prisma().outboxMessage.findMany({ where: { eventId: event.id.toString() } })
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ key: 'commit-case', status: 'PENDING', topic: 'test-topic' })
  })

  it('rolls back the row when the transaction fails after enqueueing', async () => {
    const manager = new PrismaTransactionManager(prisma())
    const repository = new OutboxRepository(MODULE)
    const event = Event.create('test.rolled-back', { ok: false })

    const result = await manager.execute(async (tx) => {
      const enqueued = await repository.enqueue(event, { key: 'rollback-case', topic: 'test-topic' }, tx)
      if (enqueued.isFailure()) return enqueued

      return failure(new RollbackTestError())
    })

    expect(result.isFailure()).toBe(true)

    const stored = await prisma().outboxMessage.findMany({ where: { eventId: event.id.toString() } })
    expect(stored).toHaveLength(0)
  })
})
```

- [ ] **Step 7: Run the integration test to verify it fails, then passes**

Run: `pnpm infra:up` (if not already up)
Run: `pnpm --filter @ruguin/core-server test:integration`
Expected: both cases PASS. If Postgres is unreachable, the failure is a connection error, not an
assertion failure — start `pnpm infra:up` first.

- [ ] **Step 8: Type-check and lint**

Run: `pnpm --filter @ruguin/core-server check:types`
Run: `pnpm --filter @ruguin/core-server check:lint`
Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add apps/core-server/src/shared/contracts/outbox.port.ts apps/core-server/src/shared/errors/duplicate-outbox-event.error.ts apps/core-server/src/shared/errors/enqueue-outbox-message.error.ts apps/core-server/src/shared/outbox/outbox.repository.ts apps/core-server/src/shared/outbox/__tests__/outbox.repository.unit.ts apps/core-server/src/shared/outbox/__tests__/outbox.repository.int.ts apps/core-server/src/shared/outbox/__tests__/outbox-test-context.ts
git commit -m "feat(core-server): add OutboxPort contract and OutboxRepository"
```

---

### Task 4: `MessageProducerPort` and `FakeMessageProducer`

**Files:**
- Create: `apps/core-server/src/shared/contracts/message-producer.port.ts`
- Create: `apps/core-server/src/shared/events/fake-message-producer.ts`
- Create: `apps/core-server/src/shared/events/__tests__/fake-message-producer.unit.ts`

**Interfaces:**
- Produces: `MESSAGE_PRODUCER_PORT` (`Symbol`) and `MessageProducerPort.publish(input: {topic: string;
  key: string; message: {eventId: string; name: string; payload: unknown}}): Promise<Either<BaseError,
  void>>`; `FakeMessageProducer` implementing it, plus `getPublished(): readonly PublishedMessage[]`
  and `clear(): void` for tests. Task 5 (relay) injects this port; Task 7
  (`OutboxModule`) binds it by default.

- [ ] **Step 1: Write the failing unit test**

```ts
// apps/core-server/src/shared/events/__tests__/fake-message-producer.unit.ts
import { describe, expect, it } from 'vitest'

import { FakeMessageProducer } from '../fake-message-producer'

describe('FakeMessageProducer', () => {
  it('records every published message and always succeeds', async () => {
    const producer = new FakeMessageProducer()

    const result = await producer.publish({
      key: 'service-a',
      message: { eventId: 'event-1', name: 'health.degraded', payload: { reason: 'timeout' } },
      topic: 'health-events'
    })

    expect(result.isSuccess()).toBe(true)
    expect(producer.getPublished()).toEqual([
      {
        key: 'service-a',
        message: { eventId: 'event-1', name: 'health.degraded', payload: { reason: 'timeout' } },
        topic: 'health-events'
      }
    ])
  })

  it('clear() empties the recorded messages', async () => {
    const producer = new FakeMessageProducer()
    await producer.publish({ key: 'k', message: { eventId: 'e', name: 'n', payload: null }, topic: 't' })

    producer.clear()

    expect(producer.getPublished()).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ruguin/core-server test`
Expected: FAIL — `../fake-message-producer` does not exist yet.

- [ ] **Step 3: Write the contract and the fake**

```ts
// apps/core-server/src/shared/contracts/message-producer.port.ts
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either } from '@ruguin/utils'

export const MESSAGE_PRODUCER_PORT = Symbol('MESSAGE_PRODUCER_PORT')

export type OutboundMessage = {
  topic: string
  key: string
  message: { eventId: string; name: string; payload: unknown }
}

export interface MessageProducerPort {
  publish(input: OutboundMessage): Promise<Either<BaseError, void>>
}
```

```ts
// apps/core-server/src/shared/events/fake-message-producer.ts
import { Injectable } from '@nestjs/common'
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either, success } from '@ruguin/utils'

import { type MessageProducerPort, type OutboundMessage } from '../contracts/message-producer.port'

@Injectable()
export class FakeMessageProducer implements MessageProducerPort {
  private readonly published: OutboundMessage[] = []

  public async publish(input: OutboundMessage): Promise<Either<BaseError, void>> {
    this.published.push(input)

    return success(undefined)
  }

  public getPublished(): readonly OutboundMessage[] {
    return this.published
  }

  public clear(): void {
    this.published.length = 0
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test`
Expected: PASS (both cases)

- [ ] **Step 5: Type-check and lint**

Run: `pnpm --filter @ruguin/core-server check:types`
Run: `pnpm --filter @ruguin/core-server check:lint`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/core-server/src/shared/contracts/message-producer.port.ts apps/core-server/src/shared/events/fake-message-producer.ts apps/core-server/src/shared/events/__tests__/fake-message-producer.unit.ts
git commit -m "feat(core-server): add MessageProducerPort contract and an in-memory fake"
```

---

### Task 5: `OutboxRelayService`

**Files:**
- Modify: `apps/core-server/package.json` (add `@nestjs/schedule`)
- Create: `apps/core-server/src/shared/outbox/outbox-relay.service.ts`
- Create: `apps/core-server/src/shared/outbox/__tests__/outbox-relay.service.unit.ts`
- Create: `apps/core-server/src/shared/outbox/__tests__/outbox-relay.service.int.ts`

**Interfaces:**
- Consumes: `PrismaService` (existing); `MessageProducerPort` (Task 4); the `outbox_messages` table
  shape (Task 2); `OutboxRepository` (Task 3, integration test only).
- Produces: `OutboxRelayService` (constructor `(prisma: PrismaService, messageProducer:
  MessageProducerPort)`), with a scheduled `relay(): Promise<void>` method. Task 7
  (`OutboxModule`) registers it as a provider.

- [ ] **Step 1: Add the `@nestjs/schedule` dependency**

Edit `apps/core-server/package.json`: in `dependencies`, add `"@nestjs/schedule": "^6.1.3"` right
after the `"@nestjs/platform-fastify"` line (alphabetical order, matching the rest of the block).

Run: `pnpm install`
Expected: lockfile updates, install succeeds.

- [ ] **Step 2: Write the failing unit test**

```ts
// apps/core-server/src/shared/outbox/__tests__/outbox-relay.service.unit.ts
import { BaseError, StatusError } from '@ruguin/ddd-kernel'
import { type Either, failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type MessageProducerPort } from '../../contracts/message-producer.port'
import { type PrismaService } from '../../database/prisma.service'
import { OutboxRelayService } from '../outbox-relay.service'

class SamplePublishError extends BaseError {
  readonly name = 'SamplePublishError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor() {
    super({ message: 'broker unavailable' })
  }
}

type Row = {
  id: string
  createdAt: Date
  eventId: string
  module: string
  topic: string
  key: string
  name: string
  payload: unknown
  attempts: number
}

function createRow(overrides: Partial<Row> = {}): Row {
  return {
    attempts: 0,
    createdAt: new Date('2026-08-02T00:00:00.000Z'),
    eventId: 'event-1',
    id: 'row-1',
    key: 'service-a',
    module: 'health',
    name: 'health.degraded',
    payload: { reason: 'timeout' },
    topic: 'health-events',
    ...overrides
  }
}

function createPrismaStub(rows: Row[]): { prisma: PrismaService; updates: Array<{ where: unknown; data: unknown }> } {
  const updates: Array<{ where: unknown; data: unknown }> = []

  const tx = {
    $queryRaw: async () => rows,
    outboxMessage: {
      update: async (args: { where: unknown; data: unknown }) => {
        updates.push(args)
        return args
      }
    }
  }

  const prisma = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(tx)
  } as unknown as PrismaService

  return { prisma, updates }
}

describe('OutboxRelayService#relay', () => {
  it('publishes each eligible row and marks it PUBLISHED', async () => {
    const row = createRow()
    const { prisma, updates } = createPrismaStub([row])
    const publish = vi.fn(async (): Promise<Either<SamplePublishError, void>> => success(undefined))
    const messageProducer: MessageProducerPort = { publish }

    const relay = new OutboxRelayService(prisma, messageProducer)
    await relay.relay()

    expect(publish).toHaveBeenCalledWith({
      key: 'service-a',
      message: { eventId: 'event-1', name: 'health.degraded', payload: { reason: 'timeout' } },
      topic: 'health-events'
    })
    expect(updates).toHaveLength(1)
    expect(updates[0]?.data).toMatchObject({ status: 'PUBLISHED' })
  })

  it('increments attempts and schedules a retry when publish fails below the max attempts', async () => {
    const row = createRow({ attempts: 1 })
    const { prisma, updates } = createPrismaStub([row])
    const messageProducer: MessageProducerPort = {
      publish: vi.fn(async (): Promise<Either<SamplePublishError, void>> => failure(new SamplePublishError()))
    }

    const relay = new OutboxRelayService(prisma, messageProducer)
    await relay.relay()

    expect(updates[0]?.data).toMatchObject({ attempts: 2 })
    expect((updates[0]?.data as { nextAttemptAt: Date }).nextAttemptAt).toBeInstanceOf(Date)
    expect((updates[0]?.data as { status?: unknown }).status).toBeUndefined()
  })

  it('moves the row to FAILED once it reaches the max attempts', async () => {
    const row = createRow({ attempts: 4 })
    const { prisma, updates } = createPrismaStub([row])
    const messageProducer: MessageProducerPort = {
      publish: vi.fn(async (): Promise<Either<SamplePublishError, void>> => failure(new SamplePublishError()))
    }

    const relay = new OutboxRelayService(prisma, messageProducer)
    await relay.relay()

    expect(updates[0]?.data).toMatchObject({ attempts: 5, status: 'FAILED' })
  })

  it('does nothing when there are no eligible rows', async () => {
    const { prisma, updates } = createPrismaStub([])
    const publish = vi.fn()
    const messageProducer: MessageProducerPort = { publish }

    const relay = new OutboxRelayService(prisma, messageProducer)
    await relay.relay()

    expect(publish).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @ruguin/core-server test`
Expected: FAIL — `../outbox-relay.service` does not exist yet.

- [ ] **Step 4: Implement `OutboxRelayService`**

```ts
// apps/core-server/src/shared/outbox/outbox-relay.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'

import { OutboxStatus, type Prisma } from '../../generated/prisma/client'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '../contracts/message-producer.port'
import { PrismaService } from '../database/prisma.service'

const RELAY_INTERVAL_MS = 1000
const BATCH_SIZE = 20
const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 1000

type EligibleRow = {
  id: string
  createdAt: Date
  eventId: string
  module: string
  topic: string
  key: string
  name: string
  payload: Prisma.JsonValue
  attempts: number
}

function computeNextAttemptAt(attempts: number): Date {
  return new Date(Date.now() + BASE_BACKOFF_MS * 2 ** attempts)
}

@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name)

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MESSAGE_PRODUCER_PORT) private readonly messageProducer: MessageProducerPort
  ) {}

  @Interval(RELAY_INTERVAL_MS)
  public async relay(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // FOR UPDATE cannot combine with a window function at the same query level, so `ranked`
      // computes eligibility unlocked and the outer SELECT re-joins by primary key to lock only
      // the winning row of each (module, key) pair. Two relay instances racing on the same tick
      // never publish out of order: only one row per key is ever eligible, and SKIP LOCKED makes
      // the loser skip it entirely rather than pick a different one.
      const rows = await tx.$queryRaw<EligibleRow[]>`
        WITH ranked AS (
          SELECT id, "createdAt",
                 ROW_NUMBER() OVER (PARTITION BY module, key ORDER BY "createdAt") AS rn
          FROM outbox_messages
          WHERE status = 'PENDING'
            AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
        )
        SELECT o.id, o."createdAt", o."eventId", o.module, o.topic, o.key, o.name, o.payload, o.attempts
        FROM outbox_messages o
        JOIN ranked r ON r.id = o.id AND r."createdAt" = o."createdAt"
        WHERE r.rn = 1
        ORDER BY o."createdAt"
        LIMIT ${BATCH_SIZE}
        FOR UPDATE OF o SKIP LOCKED
      `

      for (const row of rows) {
        await this.processRow(tx, row)
      }
    })
  }

  // NOTA PÓS-IMPLEMENTAÇÃO (não estava no brief original acima): a query final difere desta em
  // dois pontos, achados na revisão final de branch e num ciclo posterior de revisão do PR.
  //
  // 1. `ORDER BY "createdAt"` sozinho não é suficiente: `createdAt` é TIMESTAMP(3) e o Prisma
  //    grava @default(now()) no client, uma linha por vez, então enqueues rápidos (o caso comum
  //    de um use case que enfileira mais de um evento na mesma transação) colidem no milissegundo
  //    com frequência — medido em 13-16 colisões a cada 40 enqueues consecutivos. Sem desempate,
  //    o ROW_NUMBER() resolve o empate pela posição física da linha no heap, que muda quando um
  //    retry faz UPDATE na linha, invertendo a ordem no tick seguinte. A query final ordena por
  //    `"createdAt", id` (window function e ORDER BY externo) — id é uuid(7), monotônico mesmo
  //    dentro do mesmo milissegundo, e como (id, createdAt) já é a chave primária composta, isso
  //    vira uma ordem total dentro de cada (module, key).
  // 2. O filtro `nextAttemptAt` dentro do WHERE da CTE `ranked` (linha 972 acima) estava errado:
  //    ele remove uma linha em backoff da partição inteira, deixando o ROW_NUMBER() reordenar em
  //    torno dela e promover a próxima mensagem da mesma key — publicando fora de ordem depois de
  //    uma única falha transitória, sem concorrência nenhuma. O filtro de nextAttemptAt precisa
  //    ficar no WHERE externo, aplicado só sobre a linha vencedora (rn = 1), não dentro da CTE.
  //
  // Ambos os pontos são cobertos por teste de integração (aggregate-same-timestamp,
  // aggregate-retry em outbox-relay.service.int.ts).
  private async processRow(tx: Prisma.TransactionClient, row: EligibleRow): Promise<void> {
    const published = await this.messageProducer.publish({
      key: row.key,
      message: { eventId: row.eventId, name: row.name, payload: row.payload },
      topic: row.topic
    })

    if (published.isSuccess()) {
      await tx.outboxMessage.update({
        data: { publishedAt: new Date(), status: OutboxStatus.PUBLISHED },
        where: { id_createdAt: { createdAt: row.createdAt, id: row.id } }
      })
      return
    }

    const attempts = row.attempts + 1

    if (attempts >= MAX_ATTEMPTS) {
      await tx.outboxMessage.update({
        data: { attempts, lastError: published.value.message, status: OutboxStatus.FAILED },
        where: { id_createdAt: { createdAt: row.createdAt, id: row.id } }
      })
      this.logger.error(`Outbox message ${row.id} moved to FAILED after ${attempts} attempts.`)
      return
    }

    await tx.outboxMessage.update({
      data: { attempts, lastError: published.value.message, nextAttemptAt: computeNextAttemptAt(attempts) },
      where: { id_createdAt: { createdAt: row.createdAt, id: row.id } }
    })
  }
}
```

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test`
Expected: PASS (all 4 cases)

- [ ] **Step 6: Write the failing concurrency/ordering integration test**

```ts
// apps/core-server/src/shared/outbox/__tests__/outbox-relay.service.int.ts
import { Event } from '@ruguin/ddd-kernel'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { PrismaTransactionManager } from '../../database/prisma-transaction-manager'
import { type PrismaService } from '../../database/prisma.service'
import { FakeMessageProducer } from '../../events/fake-message-producer'
import { OutboxRelayService } from '../outbox-relay.service'
import { OutboxRepository } from '../outbox.repository'

import { createTestPrismaService, sleep } from './outbox-test-context'

const MODULE = 'outbox-relay-int-test'
const TICKS = 6

const context: { prisma: PrismaService | null } = { prisma: null }

const prisma = (): PrismaService => {
  if (context.prisma === null) throw new Error('prisma was never connected')
  return context.prisma
}

beforeAll(() => {
  context.prisma = createTestPrismaService()
})

afterEach(async () => {
  await prisma().outboxMessage.deleteMany({ where: { module: MODULE } })
})

afterAll(async () => {
  await prisma().$disconnect()
})

describe('OutboxRelayService against a live Postgres, with two concurrent instances', () => {
  it('never publishes a later message of the same key before an earlier one', async () => {
    const repository = new OutboxRepository(MODULE)
    const transactionManager = new PrismaTransactionManager(prisma())
    const key = 'aggregate-1'

    for (let sequence = 0; sequence < TICKS; sequence += 1) {
      const event = Event.create('test.sequenced', { sequence })
      await transactionManager.execute((tx) => repository.enqueue(event, { key, topic: 'test-topic' }, tx))
      // Guarantees distinct createdAt ordering even at low DB timestamp resolution.
      await sleep(5)
    }

    const producer = new FakeMessageProducer()
    const relayA = new OutboxRelayService(prisma(), producer)
    const relayB = new OutboxRelayService(prisma(), producer)

    // Two instances racing on the same tick, sharing the DB and the producer: at any moment only
    // the oldest message of this key is eligible, so each tick advances the chain by exactly one.
    for (let tick = 0; tick < TICKS; tick += 1) {
      await Promise.all([relayA.relay(), relayB.relay()])
    }

    const remaining = await prisma().outboxMessage.count({ where: { module: MODULE, status: 'PENDING' } })
    expect(remaining).toBe(0)

    const sequences = producer
      .getPublished()
      .filter((message) => message.key === key)
      .map((message) => (message.message.payload as { sequence: number }).sequence)

    expect(sequences).toEqual([0, 1, 2, 3, 4, 5])
  })
})
```

- [ ] **Step 7: Run the integration test to verify it fails, then passes**

Run: `pnpm infra:up` (if not already up)
Run: `pnpm --filter @ruguin/core-server test:integration`
Expected: PASS. If it fails with sequences out of order, re-check the `FOR UPDATE OF o SKIP LOCKED`
clause is present and applied to the outer query, not the `ranked` CTE.

- [ ] **Step 8: Type-check and lint**

Run: `pnpm --filter @ruguin/core-server check:types`
Run: `pnpm --filter @ruguin/core-server check:lint`
Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add apps/core-server/package.json pnpm-lock.yaml apps/core-server/src/shared/outbox/outbox-relay.service.ts apps/core-server/src/shared/outbox/__tests__/outbox-relay.service.unit.ts apps/core-server/src/shared/outbox/__tests__/outbox-relay.service.int.ts
git commit -m "feat(core-server): add OutboxRelayService with per-key ordering, retry and DLQ"
```

---

### Task 6: `OutboxPartitionMaintenanceService`

**Files:**
- Create: `apps/core-server/src/shared/outbox/outbox-partition-maintenance.service.ts`
- Create: `apps/core-server/src/shared/outbox/__tests__/outbox-partition-maintenance.service.unit.ts`
- Create: `apps/core-server/src/shared/outbox/__tests__/outbox-partition-maintenance.service.int.ts`

**Interfaces:**
- Consumes: `PrismaService` (existing).
- Produces: `OutboxPartitionMaintenanceService` (constructor `(prisma: PrismaService)`), scheduled
  `runMaintenance(): Promise<void>`. Task 7 (`OutboxModule`) registers it as a provider.

- [ ] **Step 1: Write the failing unit test**

```ts
// apps/core-server/src/shared/outbox/__tests__/outbox-partition-maintenance.service.unit.ts
import { describe, expect, it } from 'vitest'

import { type PrismaService } from '../../database/prisma.service'
import { OutboxPartitionMaintenanceService } from '../outbox-partition-maintenance.service'

function createPrismaStub(input: { stalePartitions?: string[]; nonTerminalCounts?: Record<string, number> } = {}): {
  prisma: PrismaService
  executed: string[]
} {
  const executed: string[] = []
  const stalePartitions = input.stalePartitions ?? []
  const nonTerminalCounts = input.nonTerminalCounts ?? {}

  const prisma = {
    $executeRawUnsafe: async (sql: string) => {
      executed.push(sql)
      return 0
    },
    $queryRaw: async () => stalePartitions.map((partitionName) => ({ partitionName })),
    $queryRawUnsafe: async (sql: string) => {
      const match = /FROM "([^"]+)"/.exec(sql)
      const partitionName = match?.[1] ?? ''
      return [{ count: BigInt(nonTerminalCounts[partitionName] ?? 0) }]
    }
  } as unknown as PrismaService

  return { executed, prisma }
}

describe('OutboxPartitionMaintenanceService#runMaintenance', () => {
  it('creates the current month plus the two following, each with IF NOT EXISTS', async () => {
    const { prisma, executed } = createPrismaStub()
    const service = new OutboxPartitionMaintenanceService(prisma)

    await service.runMaintenance()

    const creates = executed.filter((sql) => sql.includes('CREATE TABLE IF NOT EXISTS'))
    expect(creates).toHaveLength(3)
    for (const sql of creates) expect(sql).toContain('PARTITION OF "outbox_messages"')
  })

  it('drops a stale partition that has no PENDING or FAILED rows left', async () => {
    const { prisma, executed } = createPrismaStub({
      nonTerminalCounts: { outbox_messages_2026_01: 0 },
      stalePartitions: ['outbox_messages_2026_01']
    })
    const service = new OutboxPartitionMaintenanceService(prisma)

    await service.runMaintenance()

    expect(executed).toContain('DROP TABLE IF EXISTS "outbox_messages_2026_01"')
  })

  it('keeps a stale partition that still has non-terminal rows', async () => {
    const { prisma, executed } = createPrismaStub({
      nonTerminalCounts: { outbox_messages_2026_01: 2 },
      stalePartitions: ['outbox_messages_2026_01']
    })
    const service = new OutboxPartitionMaintenanceService(prisma)

    await service.runMaintenance()

    expect(executed.some((sql) => sql.startsWith('DROP TABLE'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ruguin/core-server test`
Expected: FAIL — `../outbox-partition-maintenance.service` does not exist yet.

- [ ] **Step 3: Implement `OutboxPartitionMaintenanceService`**

```ts
// apps/core-server/src/shared/outbox/outbox-partition-maintenance.service.ts
import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'

import { PrismaService } from '../database/prisma.service'

const MONTHS_AHEAD = 2
const RETENTION_MONTHS = 3

function partitionNameFor(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `outbox_messages_${year}_${month}`
}

function monthBoundsFor(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
  return { end, start }
}

function toSqlDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

@Injectable()
export class OutboxPartitionMaintenanceService {
  private readonly logger = new Logger(OutboxPartitionMaintenanceService.name)

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  public async runMaintenance(): Promise<void> {
    await this.ensureFuturePartitionsExist()
    await this.dropStalePartitions()
  }

  private async ensureFuturePartitionsExist(): Promise<void> {
    const now = new Date()

    for (let offset = 0; offset <= MONTHS_AHEAD; offset += 1) {
      const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
      const partitionName = partitionNameFor(target)
      const { start, end } = monthBoundsFor(target)

      // Table/partition identifiers can't be bound as query parameters — CREATE TABLE ... PARTITION
      // OF needs the name inlined. Safe here: every interpolated value comes from Date arithmetic
      // above, never from external input.
      await this.prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "${partitionName}" PARTITION OF "outbox_messages" FOR VALUES FROM ('${toSqlDate(start)}') TO ('${toSqlDate(end)}')`
      )

      this.logger.log(`Ensured outbox partition ${partitionName} exists.`)
    }
  }

  private async dropStalePartitions(): Promise<void> {
    const now = new Date()
    const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - RETENTION_MONTHS, 1))
    // Partition names are zero-padded `outbox_messages_YYYY_MM`, so lexicographic and chronological
    // order coincide — a plain string comparison is enough to find stale ones.
    const cutoffName = partitionNameFor(cutoff)

    const partitions = await this.prisma.$queryRaw<{ partitionName: string }[]>`
      SELECT child.relname AS "partitionName"
      FROM pg_inherits
      JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
      JOIN pg_class child ON pg_inherits.inhrelid = child.oid
      WHERE parent.relname = 'outbox_messages'
        AND child.relname < ${cutoffName}
    `

    for (const { partitionName } of partitions) {
      await this.dropIfEmpty(partitionName)
    }
  }

  private async dropIfEmpty(partitionName: string): Promise<void> {
    const [row] = await this.prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM "${partitionName}" WHERE status IN ('PENDING', 'FAILED')`
    )

    if (row !== undefined && Number(row.count) > 0) {
      this.logger.warn(`Skipping drop of ${partitionName}: it still has non-terminal rows.`)
      return
    }

    await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${partitionName}"`)
    this.logger.log(`Dropped stale outbox partition ${partitionName}.`)
  }
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test`
Expected: PASS (all 3 cases)

- [ ] **Step 5: Write the failing integration test**

```ts
// apps/core-server/src/shared/outbox/__tests__/outbox-partition-maintenance.service.int.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type PrismaService } from '../../database/prisma.service'
import { OutboxPartitionMaintenanceService } from '../outbox-partition-maintenance.service'

import { createTestPrismaService } from './outbox-test-context'

const context: { prisma: PrismaService | null } = { prisma: null }

const prisma = (): PrismaService => {
  if (context.prisma === null) throw new Error('prisma was never connected')
  return context.prisma
}

beforeAll(() => {
  context.prisma = createTestPrismaService()
})

afterAll(async () => {
  await prisma().$disconnect()
})

describe('OutboxPartitionMaintenanceService against a live Postgres', () => {
  it('creates future partitions that accept an insert, and is idempotent on rerun', async () => {
    const service = new OutboxPartitionMaintenanceService(prisma())

    await service.runMaintenance()
    await service.runMaintenance() // rerun must not throw (IF NOT EXISTS)

    const created = await prisma().outboxMessage.create({
      data: {
        eventId: `partition-check-${Date.now()}`,
        key: 'partition-check',
        module: 'outbox-partition-maintenance-int-test',
        name: 'test.partition-check',
        payload: {},
        topic: 'test-topic'
      }
    })

    expect(created.id).toBeDefined()

    await prisma().outboxMessage.delete({ where: { id_createdAt: { createdAt: created.createdAt, id: created.id } } })
  })

  it('drops an old, empty partition but keeps one that still has PENDING rows', async () => {
    const dropCandidate = 'outbox_messages_2020_01'
    const keepCandidate = 'outbox_messages_2020_02'

    await prisma().$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${dropCandidate}" PARTITION OF "outbox_messages" FOR VALUES FROM ('2020-01-01') TO ('2020-02-01')`
    )
    await prisma().$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${keepCandidate}" PARTITION OF "outbox_messages" FOR VALUES FROM ('2020-02-01') TO ('2020-03-01')`
    )
    await prisma().$executeRawUnsafe(
      `INSERT INTO "${keepCandidate}" (id, "eventId", module, topic, key, name, payload, status, attempts, "createdAt")
       VALUES ('kept-row', 'kept-event', 'retention-int-test', 't', 'k', 'n', '{}', 'PENDING', 0, '2020-02-15')`
    )

    const service = new OutboxPartitionMaintenanceService(prisma())
    await service.runMaintenance()

    const remaining = await prisma().$queryRaw<{ relname: string }[]>`
      SELECT child.relname
      FROM pg_inherits
      JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
      JOIN pg_class child ON pg_inherits.inhrelid = child.oid
      WHERE parent.relname = 'outbox_messages'
    `
    const names = remaining.map((row) => row.relname)

    expect(names).not.toContain(dropCandidate)
    expect(names).toContain(keepCandidate)

    await prisma().$executeRawUnsafe(`DROP TABLE IF EXISTS "${keepCandidate}"`)
  })
})
```

- [ ] **Step 6: Run the integration test to verify it fails, then passes**

Run: `pnpm infra:up` (if not already up)
Run: `pnpm --filter @ruguin/core-server test:integration`
Expected: PASS (both cases)

- [ ] **Step 7: Type-check and lint**

Run: `pnpm --filter @ruguin/core-server check:types`
Run: `pnpm --filter @ruguin/core-server check:lint`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add apps/core-server/src/shared/outbox/outbox-partition-maintenance.service.ts apps/core-server/src/shared/outbox/__tests__/outbox-partition-maintenance.service.unit.ts apps/core-server/src/shared/outbox/__tests__/outbox-partition-maintenance.service.int.ts
git commit -m "feat(core-server): add OutboxPartitionMaintenanceService"
```

---

### Task 7: `OutboxModule` and app wiring

**Files:**
- Create: `apps/core-server/src/shared/outbox/outbox.module.ts`
- Modify: `apps/core-server/src/app.module.ts`

**Interfaces:**
- Consumes: `OutboxRelayService` (Task 5), `OutboxPartitionMaintenanceService` (Task 6),
  `FakeMessageProducer` (Task 4), `OutboxRepository` (Task 3), `OUTBOX_PORT` (Task 3),
  `MESSAGE_PRODUCER_PORT` (Task 4).
- Produces: `OutboxModule` (plain module, registers the relay and the partition maintenance service
  globally) and `OutboxModule.forFeature(input: {module: string}): DynamicModule` (provides
  `OUTBOX_PORT` scoped to one business module — the entry point every future `<module>.module.ts` will
  import).

- [ ] **Step 1: Implement `OutboxModule`**

```ts
// apps/core-server/src/shared/outbox/outbox.module.ts
import { type DynamicModule, Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'

import { MESSAGE_PRODUCER_PORT } from '../contracts/message-producer.port'
import { OUTBOX_PORT } from '../contracts/outbox.port'
import { FakeMessageProducer } from '../events/fake-message-producer'

import { OutboxPartitionMaintenanceService } from './outbox-partition-maintenance.service'
import { OutboxRelayService } from './outbox-relay.service'
import { OutboxRepository } from './outbox.repository'

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [
    { provide: MESSAGE_PRODUCER_PORT, useClass: FakeMessageProducer },
    OutboxRelayService,
    OutboxPartitionMaintenanceService
  ]
})
export class OutboxModule {
  public static forFeature(input: { module: string }): DynamicModule {
    return {
      exports: [OUTBOX_PORT],
      module: OutboxModule,
      providers: [{ provide: OUTBOX_PORT, useValue: new OutboxRepository(input.module) }]
    }
  }
}
```

- [ ] **Step 2: Register `OutboxModule` in `AppModule`**

```ts
// apps/core-server/src/app.module.ts
import { Module } from '@nestjs/common'
import { CacheModule } from '@ruguin/cache'
import { cacheENV, databaseENV } from '@ruguin/env'
import { LoggerModule } from 'nestjs-pino'

import { createCacheModuleOptions } from './cache/cache-module-options'
import { HealthModule } from './health/health.module'
import { createPinoHttpOptions } from './logger/pino-http-options'
import { DatabaseModule } from './shared/database/database.module'
import { OutboxModule } from './shared/outbox/outbox.module'

@Module({
  controllers: [],
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => ({ pinoHttp: createPinoHttpOptions(process.env) })
    }),

    CacheModule.forRoot({
      isGlobal: true,
      ...createCacheModuleOptions(cacheENV)
    }),
    DatabaseModule.forRoot({ connectionString: databaseENV.DATABASE_URL }),
    OutboxModule,
    HealthModule
  ],
  providers: []
})
export class AppModule {}
```

- [ ] **Step 3: Boot the app and confirm it still starts cleanly**

Run: `pnpm infra:up` (if not already up)
Run: `pnpm --filter @ruguin/core-server build`
Run: `pnpm with-env pnpm --filter @ruguin/core-server start`

Expected: the process starts without throwing, logs from `OutboxRelayService`/
`OutboxPartitionMaintenanceService` do not appear (nothing pending yet, cron hasn't fired), `GET
/health` still responds. Stop the process (`Ctrl+C`) once confirmed.

- [ ] **Step 4: Run the full existing e2e suite to confirm no regression**

Run: `pnpm --filter @ruguin/core-server test:e2e`
Expected: PASS — the existing health e2e suite is unaffected by `OutboxModule` being globally
registered.

- [ ] **Step 5: Type-check and lint the whole app**

Run: `pnpm --filter @ruguin/core-server check:types`
Run: `pnpm --filter @ruguin/core-server check:lint`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/core-server/src/shared/outbox/outbox.module.ts apps/core-server/src/app.module.ts
git commit -m "feat(core-server): wire OutboxModule into AppModule"
```
