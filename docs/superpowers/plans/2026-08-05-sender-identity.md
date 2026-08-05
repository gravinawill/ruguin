# SenderIdentity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each project register verified sender email addresses (`SenderIdentity`), verified
natively via AWS SES, and require every `POST /v1/emails` send to resolve its sender from a
`Template`'s configured `SenderIdentity` — never from a free-text `from` in the request.

**Architecture:** One new module (`sender-identities`) in `apps/core-server`, following the same
domain/application/infrastructure/presentation layering as `templates`/`api-keys`. `Template` gains
a required `senderIdentityId` FK; `Email` gains `senderIdentityId` and a now-required `templateId`.
`POST /v1/emails` drops the `subject`+`html` direct-send path entirely. A cache-backed lookup
(mirroring `ApiKeyAuthGuard`'s pattern) resolves the sender at send time; a polling job (mirroring
`OutboxRelayService`'s `@Interval` pattern) syncs verification status from SES.

**Tech Stack:** NestJS 11 + Fastify, Prisma 7, `@aws-sdk/client-sesv2` (new), `@ruguin/cache`,
`@ruguin/shared-domain` (`Either`, `BaseError`, `ID`), Zod 4.

**Spec:** `docs/superpowers/specs/2026-08-05-sender-identity-design.md`

## Global Constraints

- **`Either<F, S>` failure-type variance.** `Failure<F1, S>` is not assignable to a function typed
  to return `Failure<F2, S>` even when `F1` is a member of the union `F2`, because TypeScript treats
  `Failure`'s generic type parameter invariantly here. When forwarding a narrowed failure value
  across a differing declared success type, `return failure(x.value)`, never `return x` directly.
- **Annotate the return type of any function returning `Either`.** `success(x)` alone infers
  `Either<unknown, X>` — the error type never appears in the arguments. Without an explicit
  `Promise<Either<SpecificError, X>>` return type on the method, this surfaces as a confusing
  mismatch far from the actual cause.
- **`domain/` never imports NestJS, Prisma, or any framework.** A `grep` for those names inside a
  module's `domain/` must return nothing.
- **Repositories translate infrastructure errors into domain errors.** A thrown Prisma error is
  always caught and wrapped in a `Find*Error`/`Create*Error` — `throw` never escapes a repository
  method.
- **Cache namespace strings must not contain `:` or whitespace.** `@ruguin/cache`'s `KeyBuilder`
  rejects both (`packages/cache/src/infra/key-builder.ts`); a namespace like `'core-server:x'`
  fails validation on every call and is silently swallowed by `getOrSet`'s fail-open contract — the
  cache then never caches anything, with no test failure to catch it. Use hyphens:
  `'core-server-sender-identity'`.
- **`@Interval`/`@Cron` decorator arguments are evaluated at class-definition (module import) time,
  not at DI-instantiation time.** They cannot read a `coreServerENV` field directly — accessing any
  property on the lazy env proxy at import time forces full schema validation immediately,
  independent of whether the importing context (e.g. a test file that only needs one unrelated
  export) ever provides the required vars. Interval/cron periods in this codebase are therefore
  plain numeric constants (see `OutboxRelayService`'s `RELAY_INTERVAL_MS`), not env-configurable —
  Task 7 follows this precedent for `SENDER_IDENTITY_SYNC_INTERVAL_MS`, not the spec's original
  suggestion of an env var. TTL values read inside a method body (not a decorator argument), like
  `API_KEY_CACHE_TTL_IN_SECONDS` in `ApiKeyAuthGuard.canActivate`, do not have this problem and stay
  env-configurable.
- **Repository/model field order matters for constructor positional args.** Match the exact
  parameter order given in each task's code — a later task's `new Email(...)` call site depends on
  it.
- **Never commit AWS credentials.** LocalStack accepts any non-empty string as
  `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`; the value `'test'` is the existing convention in this
  repo's own tests (`packages/env/src/packages/__tests__/aws.environment.unit.ts`) and carries no
  real credential.

---

### Task 1: Split `awsENV` into `awsENV` (generic) + `sesENV` (sending-specific)

**Files:**

- Modify: `packages/env/src/packages/aws.environment.ts`
- Create: `packages/env/src/packages/ses.environment.ts`
- Modify: `packages/env/src/packages/index.ts`
- Modify: `packages/env/src/apps/dispatch-worker.environment.ts`
- Test: `packages/env/src/packages/__tests__/aws.environment.unit.ts` (modify)
- Test: `packages/env/src/packages/__tests__/ses.environment.unit.ts` (create)
- Test: `packages/env/src/apps/__tests__/dispatch-worker.environment.unit.ts` (modify)

**Interfaces:**

- Produces: `sesENV.SES_FROM_ADDRESS: string`, `sesENV.SES_SEND_RATE_LIMIT_PER_SECOND: number` —
  consumed by Task 4's dispatch-worker touch is not needed (dispatch-worker already reads these via
  `awsENV` today; after this task it reads them via `sesENV` instead, no call-site change needed
  since `dispatchWorkerENV` re-exposes both through the same `extends` composition).
- Produces: `awsENV.AWS_REGION: string`, `awsENV.AWS_ENDPOINT_URL: string | undefined`,
  `awsENV.AWS_ACCESS_KEY_ID: string | undefined`, `awsENV.AWS_SECRET_ACCESS_KEY: string | undefined`
  — consumed by Task 4 (`coreServerENV` extends `awsENV`).

- [ ] **Step 1: Write the failing test for the trimmed-down `awsENV`**

Replace the full contents of `packages/env/src/packages/__tests__/aws.environment.unit.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('awsENV', () => {
  const originalEnvironment = { ...process.env }

  beforeEach(() => {
    /*
     * A developer's own shell (e.g. an AWS CLI profile) can already export these — clear them so
     * the default-value assertions below reflect the schema's defaults, not the ambient machine.
     */
    delete process.env.AWS_REGION
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SECRET_ACCESS_KEY
    delete process.env.AWS_ENDPOINT_URL
  })

  afterEach(() => {
    process.env = { ...originalEnvironment }
  })

  it('defaults AWS_REGION to us-east-1', async () => {
    vi.resetModules()
    const { awsENV } = await import('../aws.environment.ts')

    expect(awsENV.AWS_REGION).toBe('us-east-1')
  })

  it('reads AWS_ENDPOINT_URL when set, for LocalStack', async () => {
    process.env.AWS_ENDPOINT_URL = 'http://localhost:4566'

    vi.resetModules()
    const { awsENV } = await import('../aws.environment.ts')

    expect(awsENV.AWS_ENDPOINT_URL).toBe('http://localhost:4566')
  })

  it('parses with AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY absent, for a real AWS deployment using the default credential chain', async () => {
    vi.resetModules()
    const { awsENV } = await import('../aws.environment.ts')

    expect(awsENV.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(awsENV.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })

  it('reads AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY when set, for LocalStack', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'test'
    process.env.AWS_SECRET_ACCESS_KEY = 'test'

    vi.resetModules()
    const { awsENV } = await import('../aws.environment.ts')

    expect(awsENV.AWS_ACCESS_KEY_ID).toBe('test')
    expect(awsENV.AWS_SECRET_ACCESS_KEY).toBe('test')
  })
})
```

Create `packages/env/src/packages/__tests__/ses.environment.unit.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('sesENV', () => {
  const originalEnvironment = { ...process.env }

  beforeEach(() => {
    delete process.env.SES_SEND_RATE_LIMIT_PER_SECOND
    process.env.SES_FROM_ADDRESS = 'sender@ruguin.dev'
  })

  afterEach(() => {
    process.env = { ...originalEnvironment }
  })

  it('requires SES_FROM_ADDRESS', async () => {
    delete process.env.SES_FROM_ADDRESS

    vi.resetModules()
    const { sesENV } = await import('../ses.environment.ts')

    expect(() => ({ ...sesENV })).toThrow()
  })

  it('defaults SES_SEND_RATE_LIMIT_PER_SECOND to 14', async () => {
    vi.resetModules()
    const { sesENV } = await import('../ses.environment.ts')

    expect(sesENV.SES_SEND_RATE_LIMIT_PER_SECOND).toBe(14)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ruguin/env test:unit`
Expected: `ses.environment.unit.ts` fails with a module-not-found error (`../ses.environment.ts`
does not exist yet); `aws.environment.unit.ts` fails because the current `awsENV` still requires
`SES_FROM_ADDRESS`, and `SES_SEND_RATE_LIMIT_PER_SECOND` assertions were removed from it in the test
but the module still has the field, so the failing tests are the ones checking `awsENV` no longer
carries SES-specific fields — the new `ses.environment.unit.ts` failing to resolve is the primary
expected failure here.

- [ ] **Step 3: Trim `awsENV` down to generic AWS credentials**

Replace the full contents of `packages/env/src/packages/aws.environment.ts`:

```ts
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { lazyEnvironment } from '../shared/lazy-environment.ts'

export const awsENV = lazyEnvironment(() =>
  createEnv({
    server: {
      AWS_REGION: z.string().min(1).default('us-east-1'),
      AWS_ENDPOINT_URL: z.url().optional(),
      /*
       * Optional on purpose: these are only meant for LocalStack (paired with AWS_ENDPOINT_URL).
       * A real AWS deployment must be able to rely on the SDK's default credential provider chain
       * (an ECS task role, an EKS service-account role, an instance profile) instead of carrying
       * long-lived static keys that can't rotate automatically — see any *-client.provider.ts,
       * which only passes `credentials` through when AWS_ENDPOINT_URL is set.
       */
      AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
      AWS_SECRET_ACCESS_KEY: z.string().min(1).optional()
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
```

- [ ] **Step 4: Create `sesENV`**

Create `packages/env/src/packages/ses.environment.ts`:

```ts
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { lazyEnvironment } from '../shared/lazy-environment.ts'

/*
 * Split out of awsENV: these are specific to actually SENDING via SES (dispatch-worker), not to
 * managing AWS credentials in general. core-server also talks to SES now (sender identity
 * management, see apps/core-server.environment.ts), but never sends — extending this on top of
 * generic awsENV would force it to configure a from-address it never uses.
 */
export const sesENV = lazyEnvironment(() =>
  createEnv({
    server: {
      SES_FROM_ADDRESS: z.email(),
      SES_SEND_RATE_LIMIT_PER_SECOND: z.coerce.number().int().positive().default(14)
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
```

- [ ] **Step 5: Export `sesENV` from the packages barrel**

In `packages/env/src/packages/index.ts`, add a line (alphabetically, after `message-broker.environment.ts`
and before `test-seed.environment.ts`):

```ts
export * from './ses.environment.ts'
```

- [ ] **Step 6: Update `dispatchWorkerENV` to extend `sesENV` too**

In `packages/env/src/apps/dispatch-worker.environment.ts`, add the import and extend entry:

```ts
import { createEnv } from '@t3-oss/env-core'

import { awsENV } from '../packages/aws.environment.ts'
import { cacheENV } from '../packages/cache.environment.ts'
import { messageBrokerENV } from '../packages/message-broker.environment.ts'
import { sesENV } from '../packages/ses.environment.ts'
import { lazyEnvironment } from '../shared/lazy-environment.ts'
import { serverENV } from '../shared/server.environment.ts'

export const dispatchWorkerENV = lazyEnvironment(() =>
  createEnv({
    server: {},
    extends: [serverENV, cacheENV, messageBrokerENV, awsENV, sesENV],
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @ruguin/env test:unit`
Expected: PASS. `dispatch-worker.environment.unit.ts` (unmodified — its
`MINIMUM_REQUIRED_ENVIRONMENT` already includes `SES_FROM_ADDRESS`, which now flows through `sesENV`
instead of `awsENV`; the test doesn't care which package a field comes from) should already pass
unmodified. If it doesn't, re-check Step 6's `extends` array.

- [ ] **Step 8: Run the full workspace type check**

Run: `pnpm --filter @ruguin/env check:types && pnpm --filter @ruguin/dispatch-worker check:types`
Expected: PASS — `apps/dispatch-worker/src/email/infra/ses/ses-client.provider.ts` reads
`awsENV.AWS_REGION`/`AWS_ENDPOINT_URL`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, all of which
still exist on the trimmed `awsENV` — no call-site changes needed there. Nothing in dispatch-worker
reads `awsENV.SES_FROM_ADDRESS` or `awsENV.SES_SEND_RATE_LIMIT_PER_SECOND` directly (only via
`dispatchWorkerENV`, already fixed in Step 6).

- [ ] **Step 9: Commit**

```bash
git add packages/env apps/dispatch-worker
git commit -m "refactor(env): split awsENV into generic aws + sending-specific ses"
```

---

### Task 2: `SenderIdentity` domain model + errors

**Files:**

- Create: `apps/core-server/src/modules/sender-identities/domain/models/sender-identity.model.ts`
- Test: `apps/core-server/src/modules/sender-identities/domain/models/__tests__/sender-identity.model.unit.ts`
- Create: `apps/core-server/src/modules/sender-identities/domain/errors/invalid-sender-identity.error.ts`
- Create: `apps/core-server/src/modules/sender-identities/domain/errors/create-sender-identity.error.ts`
- Create: `apps/core-server/src/modules/sender-identities/domain/errors/duplicate-sender-identity-email.error.ts`
- Create: `apps/core-server/src/modules/sender-identities/domain/errors/find-sender-identity.error.ts`

**Interfaces:**

- Produces: `SenderIdentity.create(input: { id: ID; projectId: string; name: string; email: string;
  verifiedAt: Date | null; createdAt: Date }): Either<InvalidSenderIdentityError, SenderIdentity>` —
  consumed by Task 3 (repository's `toDomain`), Task 6 (register use case), Task 9's seed.
- Produces: `SenderIdentity#isVerified(): boolean`, `SenderIdentity#domain: string` (getter) —
  consumed by Task 8 (controller response shape), Task 11 (send-flow enforcement check).
- Produces: `InvalidSenderIdentityError`, `CreateSenderIdentityError`,
  `DuplicateSenderIdentityEmailError`, `FindSenderIdentityError` — consumed by Task 3's repository.

- [ ] **Step 1: Write the failing test**

Create `apps/core-server/src/modules/sender-identities/domain/models/__tests__/sender-identity.model.unit.ts`:

```ts
import { ID } from '@ruguin/shared-domain'
import { describe, expect, it } from 'vitest'

import { SenderIdentity } from '../sender-identity.model'

function validId(): ID {
  const generated = ID.generate({ modelName: 'SenderIdentity' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('SenderIdentity.create', () => {
  it('builds an unverified SenderIdentity from valid input', () => {
    const result = SenderIdentity.create({
      id: validId(),
      projectId: 'project-1',
      name: 'Will Gravina',
      email: 'will@gravina.dev',
      verifiedAt: null,
      createdAt: new Date('2026-08-05T00:00:00Z')
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.isVerified()).toBe(false)
      expect(result.value.domain).toBe('gravina.dev')
    }
  })

  it('reports isVerified() true once verifiedAt is set', () => {
    const result = SenderIdentity.create({
      id: validId(),
      projectId: 'project-1',
      name: 'Will Gravina',
      email: 'will@gravina.dev',
      verifiedAt: new Date('2026-08-05T01:00:00Z'),
      createdAt: new Date('2026-08-05T00:00:00Z')
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.isVerified()).toBe(true)
  })

  it('rejects an empty projectId', () => {
    const result = SenderIdentity.create({
      id: validId(),
      projectId: '',
      name: 'Will Gravina',
      email: 'will@gravina.dev',
      verifiedAt: null,
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty name', () => {
    const result = SenderIdentity.create({
      id: validId(),
      projectId: 'project-1',
      name: '',
      email: 'will@gravina.dev',
      verifiedAt: null,
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty email', () => {
    const result = SenderIdentity.create({
      id: validId(),
      projectId: 'project-1',
      name: 'Will Gravina',
      email: '',
      verifiedAt: null,
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ruguin/core-server test -- sender-identity.model.unit`
Expected: FAIL — `../sender-identity.model` does not exist yet.

- [ ] **Step 3: Write the four error classes**

Create `apps/core-server/src/modules/sender-identities/domain/errors/invalid-sender-identity.error.ts`:

```ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class InvalidSenderIdentityError extends BaseError {
  readonly name = 'InvalidSenderIdentityError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { reason: string }) {
    super({ message: `Invalid sender identity record: ${input.reason}.` })
  }
}
```

Create `apps/core-server/src/modules/sender-identities/domain/errors/create-sender-identity.error.ts`:

```ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class CreateSenderIdentityError extends BaseError {
  readonly name = 'CreateSenderIdentityError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to create the sender identity.' })
  }
}
```

Create `apps/core-server/src/modules/sender-identities/domain/errors/duplicate-sender-identity-email.error.ts`:

```ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class DuplicateSenderIdentityEmailError extends BaseError {
  readonly name = 'DuplicateSenderIdentityEmailError'
  readonly status = StatusError.CONFLICT

  constructor(input: { email: string }) {
    super({ message: `A sender identity for ${input.email} is already registered.` })
  }
}
```

Create `apps/core-server/src/modules/sender-identities/domain/errors/find-sender-identity.error.ts`:

```ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class FindSenderIdentityError extends BaseError {
  readonly name = 'FindSenderIdentityError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to look up the sender identity.' })
  }
}
```

- [ ] **Step 4: Write the model**

Create `apps/core-server/src/modules/sender-identities/domain/models/sender-identity.model.ts`:

```ts
import { type ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidSenderIdentityError } from '../errors/invalid-sender-identity.error'

export class SenderIdentity {
  private constructor(
    readonly id: ID,
    readonly projectId: string,
    readonly name: string,
    readonly email: string,
    readonly verifiedAt: Date | null,
    readonly createdAt: Date
  ) {
    Object.freeze(this)
  }

  public static create(input: {
    id: ID
    projectId: string
    name: string
    email: string
    verifiedAt: Date | null
    createdAt: Date
  }): Either<InvalidSenderIdentityError, SenderIdentity> {
    if (input.projectId.trim().length === 0) {
      return failure(new InvalidSenderIdentityError({ reason: 'projectId is empty' }))
    }
    if (input.name.trim().length === 0) return failure(new InvalidSenderIdentityError({ reason: 'name is empty' }))
    if (input.email.trim().length === 0) return failure(new InvalidSenderIdentityError({ reason: 'email is empty' }))

    return success(
      new SenderIdentity(input.id, input.projectId, input.name, input.email, input.verifiedAt, input.createdAt)
    )
  }

  public isVerified(): boolean {
    return this.verifiedAt !== null
  }

  /*
   * Not persisted (design spec decision 1) — derived on demand so it can never drift from `email`.
   * Falls back to '' rather than throwing: domain-layer validation only requires `email` to be
   * non-empty, not a well-formed address (that's the DTO's z.email() at Task 8's HTTP boundary), so
   * a malformed value here must degrade gracefully, not crash a getter.
   */
  public get domain(): string {
    const parts = this.email.split('@')
    return parts[1] ?? ''
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- sender-identity.model.unit`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/core-server/src/modules/sender-identities
git commit -m "feat(core-server): SenderIdentity domain model and errors"
```

---

### Task 3: `sender_identities` table + `SenderIdentityRepository`

**Files:**

- Create: `apps/core-server/prisma/schema/sender-identity.prisma`
- Create: `apps/core-server/prisma/migrations/20260805070000_add_sender_identities/migration.sql`
- Create: `apps/core-server/src/modules/sender-identities/domain/contracts/repositories/sender-identity.repository.ts`
- Create: `apps/core-server/src/modules/sender-identities/infrastructure/database/prisma/sender-identity.repository.ts`
- Test: `apps/core-server/src/modules/sender-identities/infrastructure/database/prisma/__tests__/sender-identity.repository.unit.ts`
- Test: `apps/core-server/src/modules/sender-identities/infrastructure/database/prisma/__tests__/sender-identity.repository.int.ts`

**Interfaces:**

- Consumes: `SenderIdentity.create(...)` (Task 2), `PrismaService` (`shared/infrastructure/database/prisma/prisma.service`, existing).
- Produces: `SENDER_IDENTITY_REPOSITORY` token and `SenderIdentityRepository` contract —
  `create({senderIdentity})`, `findById({id})`, `findManyByProjectId({projectId})`,
  `findUnverified()`, `markVerified({id, verifiedAt})` — consumed by Task 5 (cache provider), Task 6
  (use cases), Task 7 (sync job).

- [ ] **Step 1: Add the Prisma model**

Create `apps/core-server/prisma/schema/sender-identity.prisma`:

```prisma
model SenderIdentity {
  id         String    @id @default(uuid(7))
  projectId  String
  name       String
  email      String    @unique
  verifiedAt DateTime?
  createdAt  DateTime  @default(now())

  @@index([projectId])
  @@map("sender_identities")
}
```

- [ ] **Step 2: Write the migration by hand**

Create the directory `apps/core-server/prisma/migrations/20260805070000_add_sender_identities/` and
inside it `migration.sql`:

```sql
-- CreateTable
CREATE TABLE "sender_identities" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sender_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sender_identities_email_key" ON "sender_identities"("email");

-- CreateIndex
CREATE INDEX "sender_identities_projectId_idx" ON "sender_identities"("projectId");
```

Apply it: `pnpm with-env pnpm --filter @ruguin/core-server db:deploy`
Then regenerate the client: `pnpm --filter @ruguin/core-server db:generate`

- [ ] **Step 3: Write the failing repository unit test**

Create `apps/core-server/src/modules/sender-identities/infrastructure/database/prisma/__tests__/sender-identity.repository.unit.ts`:

```ts
import { ID } from '@ruguin/shared-domain'
import { describe, expect, it, vi } from 'vitest'

import { type PrismaService } from '../../../../../../shared/infrastructure/database/prisma/prisma.service'
import { SenderIdentity } from '../../../../domain/models/sender-identity.model'
import { SenderIdentityRepository } from '../sender-identity.repository'

function validId(): ID {
  const generated = ID.generate({ modelName: 'SenderIdentity' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildSenderIdentity(overrides: Partial<{ verifiedAt: Date | null }> = {}) {
  const result = SenderIdentity.create({
    id: validId(),
    projectId: 'project-1',
    name: 'Will Gravina',
    email: 'will@gravina.dev',
    verifiedAt: overrides.verifiedAt ?? null,
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

describe('SenderIdentityRepository', () => {
  describe('create', () => {
    it('persists the row and returns the mapped domain model', async () => {
      const senderIdentity = buildSenderIdentity()
      const create = vi.fn().mockResolvedValue({
        id: senderIdentity.id.toString(),
        projectId: senderIdentity.projectId,
        name: senderIdentity.name,
        email: senderIdentity.email,
        verifiedAt: null,
        createdAt: senderIdentity.createdAt
      })
      const prisma = { senderIdentity: { create } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)

      const result = await repository.create({ senderIdentity })

      expect(result.isSuccess()).toBe(true)
      expect(create).toHaveBeenCalledWith({
        data: {
          id: senderIdentity.id.toString(),
          projectId: 'project-1',
          name: 'Will Gravina',
          email: 'will@gravina.dev',
          verifiedAt: null
        }
      })
    })

    it('maps a P2002 violation to DuplicateSenderIdentityEmailError', async () => {
      const senderIdentity = buildSenderIdentity()
      const create = vi.fn().mockRejectedValue({ code: 'P2002' })
      const prisma = { senderIdentity: { create } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)

      const result = await repository.create({ senderIdentity })

      expect(result.isFailure()).toBe(true)
      if (result.isFailure()) expect(result.value.name).toBe('DuplicateSenderIdentityEmailError')
    })

    it('maps any other thrown error to CreateSenderIdentityError', async () => {
      const senderIdentity = buildSenderIdentity()
      const create = vi.fn().mockRejectedValue(new Error('connection reset'))
      const prisma = { senderIdentity: { create } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)

      const result = await repository.create({ senderIdentity })

      expect(result.isFailure()).toBe(true)
      if (result.isFailure()) expect(result.value.name).toBe('CreateSenderIdentityError')
    })
  })

  describe('findById', () => {
    it('returns { senderIdentity: null } when no row matches', async () => {
      const findUnique = vi.fn().mockResolvedValue(null)
      const prisma = { senderIdentity: { findUnique } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)

      const result = await repository.findById({ id: validId().toString() })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value.senderIdentity).toBeNull()
    })

    it('maps a found row into a SenderIdentity', async () => {
      const senderIdentity = buildSenderIdentity()
      const findUnique = vi.fn().mockResolvedValue({
        id: senderIdentity.id.toString(),
        projectId: senderIdentity.projectId,
        name: senderIdentity.name,
        email: senderIdentity.email,
        verifiedAt: null,
        createdAt: senderIdentity.createdAt
      })
      const prisma = { senderIdentity: { findUnique } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)

      const result = await repository.findById({ id: senderIdentity.id.toString() })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value.senderIdentity?.email).toBe('will@gravina.dev')
    })
  })

  describe('findManyByProjectId', () => {
    it('maps every row scoped to the project, ordered by createdAt', async () => {
      const senderIdentity = buildSenderIdentity()
      const findMany = vi.fn().mockResolvedValue([
        {
          id: senderIdentity.id.toString(),
          projectId: senderIdentity.projectId,
          name: senderIdentity.name,
          email: senderIdentity.email,
          verifiedAt: null,
          createdAt: senderIdentity.createdAt
        }
      ])
      const prisma = { senderIdentity: { findMany } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)

      const result = await repository.findManyByProjectId({ projectId: 'project-1' })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value.senderIdentities).toHaveLength(1)
      expect(findMany).toHaveBeenCalledWith({ where: { projectId: 'project-1' }, orderBy: { createdAt: 'asc' } })
    })
  })

  describe('findUnverified', () => {
    it('queries rows with verifiedAt IS NULL', async () => {
      const findMany = vi.fn().mockResolvedValue([])
      const prisma = { senderIdentity: { findMany } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)

      const result = await repository.findUnverified()

      expect(result.isSuccess()).toBe(true)
      expect(findMany).toHaveBeenCalledWith({ where: { verifiedAt: null } })
    })
  })

  describe('markVerified', () => {
    it('updates verifiedAt on the given row', async () => {
      const update = vi.fn().mockResolvedValue({})
      const prisma = { senderIdentity: { update } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)
      const verifiedAt = new Date('2026-08-05T12:00:00Z')

      const result = await repository.markVerified({ id: 'sender-1', verifiedAt })

      expect(result.isSuccess()).toBe(true)
      expect(update).toHaveBeenCalledWith({ where: { id: 'sender-1' }, data: { verifiedAt } })
    })

    it('maps a thrown error to FindSenderIdentityError', async () => {
      const update = vi.fn().mockRejectedValue(new Error('db down'))
      const prisma = { senderIdentity: { update } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)

      const result = await repository.markVerified({ id: 'sender-1', verifiedAt: new Date() })

      expect(result.isFailure()).toBe(true)
      if (result.isFailure()) expect(result.value.name).toBe('FindSenderIdentityError')
    })
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @ruguin/core-server test -- sender-identity.repository.unit`
Expected: FAIL — neither the contract file nor the repository implementation exist yet.

- [ ] **Step 5: Write the repository contract**

Create `apps/core-server/src/modules/sender-identities/domain/contracts/repositories/sender-identity.repository.ts`:

```ts
import { type Either } from '@ruguin/utils'

import { type CreateSenderIdentityError } from '../../errors/create-sender-identity.error'
import { type DuplicateSenderIdentityEmailError } from '../../errors/duplicate-sender-identity-email.error'
import { type FindSenderIdentityError } from '../../errors/find-sender-identity.error'
import { type SenderIdentity } from '../../models/sender-identity.model'

export const SENDER_IDENTITY_REPOSITORY = Symbol('SENDER_IDENTITY_REPOSITORY')

export interface SenderIdentityRepository {
  create(input: {
    senderIdentity: SenderIdentity
  }): Promise<Either<CreateSenderIdentityError | DuplicateSenderIdentityEmailError, SenderIdentity>>

  findById(input: { id: string }): Promise<Either<FindSenderIdentityError, { senderIdentity: SenderIdentity | null }>>

  findManyByProjectId(input: {
    projectId: string
  }): Promise<Either<FindSenderIdentityError, { senderIdentities: SenderIdentity[] }>>

  findUnverified(): Promise<Either<FindSenderIdentityError, { senderIdentities: SenderIdentity[] }>>

  markVerified(input: { id: string; verifiedAt: Date }): Promise<Either<FindSenderIdentityError, void>>
}
```

- [ ] **Step 6: Write the Prisma repository implementation**

Create `apps/core-server/src/modules/sender-identities/infrastructure/database/prisma/sender-identity.repository.ts`:

```ts
import { Injectable } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { PrismaService } from '../../../../../shared/infrastructure/database/prisma/prisma.service'
import { type SenderIdentityRepository as SenderIdentityRepositoryContract } from '../../../domain/contracts/repositories/sender-identity.repository'
import { CreateSenderIdentityError } from '../../../domain/errors/create-sender-identity.error'
import { DuplicateSenderIdentityEmailError } from '../../../domain/errors/duplicate-sender-identity-email.error'
import { FindSenderIdentityError } from '../../../domain/errors/find-sender-identity.error'
import { InvalidSenderIdentityError } from '../../../domain/errors/invalid-sender-identity.error'
import { SenderIdentity } from '../../../domain/models/sender-identity.model'

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

@Injectable()
export class SenderIdentityRepository implements SenderIdentityRepositoryContract {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(row: {
    id: string
    projectId: string
    name: string
    email: string
    verifiedAt: Date | null
    createdAt: Date
  }): Either<InvalidSenderIdentityError, SenderIdentity> {
    const idResult = ID.validate({ id: row.id, modelName: 'SenderIdentity' })
    if (idResult.isFailure()) return failure(new InvalidSenderIdentityError({ reason: idResult.value.message }))

    return SenderIdentity.create({
      id: idResult.value.idValidated,
      projectId: row.projectId,
      name: row.name,
      email: row.email,
      verifiedAt: row.verifiedAt,
      createdAt: row.createdAt
    })
  }

  public async create(input: {
    senderIdentity: SenderIdentity
  }): Promise<Either<CreateSenderIdentityError | DuplicateSenderIdentityEmailError, SenderIdentity>> {
    try {
      const row = await this.prisma.senderIdentity.create({
        data: {
          id: input.senderIdentity.id.toString(),
          projectId: input.senderIdentity.projectId,
          name: input.senderIdentity.name,
          email: input.senderIdentity.email,
          verifiedAt: input.senderIdentity.verifiedAt
        }
      })

      const mapped = this.toDomain(row)
      if (mapped.isFailure()) return failure(new CreateSenderIdentityError({ error: mapped.value }))

      return success(mapped.value)
    } catch (error: unknown) {
      if (isUniqueConstraintViolation(error)) {
        return failure(new DuplicateSenderIdentityEmailError({ email: input.senderIdentity.email }))
      }
      return failure(new CreateSenderIdentityError({ error }))
    }
  }

  public async findById(input: {
    id: string
  }): Promise<Either<FindSenderIdentityError, { senderIdentity: SenderIdentity | null }>> {
    try {
      const row = await this.prisma.senderIdentity.findUnique({ where: { id: input.id } })
      if (row === null) return success({ senderIdentity: null })

      const mapped = this.toDomain(row)
      if (mapped.isFailure()) return failure(new FindSenderIdentityError({ error: mapped.value }))

      return success({ senderIdentity: mapped.value })
    } catch (error: unknown) {
      return failure(new FindSenderIdentityError({ error }))
    }
  }

  public async findManyByProjectId(input: {
    projectId: string
  }): Promise<Either<FindSenderIdentityError, { senderIdentities: SenderIdentity[] }>> {
    try {
      const rows = await this.prisma.senderIdentity.findMany({
        where: { projectId: input.projectId },
        orderBy: { createdAt: 'asc' }
      })

      const senderIdentities: SenderIdentity[] = []
      for (const row of rows) {
        const mapped = this.toDomain(row)
        if (mapped.isFailure()) return failure(new FindSenderIdentityError({ error: mapped.value }))
        senderIdentities.push(mapped.value)
      }

      return success({ senderIdentities })
    } catch (error: unknown) {
      return failure(new FindSenderIdentityError({ error }))
    }
  }

  public async findUnverified(): Promise<Either<FindSenderIdentityError, { senderIdentities: SenderIdentity[] }>> {
    try {
      const rows = await this.prisma.senderIdentity.findMany({ where: { verifiedAt: null } })

      const senderIdentities: SenderIdentity[] = []
      for (const row of rows) {
        const mapped = this.toDomain(row)
        if (mapped.isFailure()) return failure(new FindSenderIdentityError({ error: mapped.value }))
        senderIdentities.push(mapped.value)
      }

      return success({ senderIdentities })
    } catch (error: unknown) {
      return failure(new FindSenderIdentityError({ error }))
    }
  }

  public async markVerified(input: { id: string; verifiedAt: Date }): Promise<Either<FindSenderIdentityError, void>> {
    try {
      await this.prisma.senderIdentity.update({ where: { id: input.id }, data: { verifiedAt: input.verifiedAt } })
      return success(undefined)
    } catch (error: unknown) {
      return failure(new FindSenderIdentityError({ error }))
    }
  }
}
```

- [ ] **Step 7: Run the unit test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- sender-identity.repository.unit`
Expected: PASS (9 tests).

- [ ] **Step 8: Write and run the integration test**

Create `apps/core-server/src/modules/sender-identities/infrastructure/database/prisma/__tests__/sender-identity.repository.int.ts`:

```ts
import { randomUUID } from 'node:crypto'

import { ID } from '@ruguin/shared-domain'
import { afterAll, describe, expect, it } from 'vitest'

import { createTestPrismaService } from '../../../../../../shared/infrastructure/outbox/__tests__/outbox-test-context'
import { SenderIdentity } from '../../../../domain/models/sender-identity.model'
import { SenderIdentityRepository } from '../sender-identity.repository'

const prisma = createTestPrismaService()
const repository = new SenderIdentityRepository(prisma)

function validId(): ID {
  const generated = ID.generate({ modelName: 'SenderIdentity' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

async function seedProject(): Promise<string> {
  const organization = await prisma.organization.create({ data: { name: `Org ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { organizationId: organization.id, name: `Project ${randomUUID()}` }
  })
  return project.id
}

afterAll(async () => {
  await prisma.$disconnect()
})

describe('SenderIdentityRepository (integration)', () => {
  it('rejects a second sender identity with the same email, even from a different project', async () => {
    const email = `will+${randomUUID()}@gravina.dev`
    const firstProjectId = await seedProject()
    const secondProjectId = await seedProject()

    const first = SenderIdentity.create({
      id: validId(),
      projectId: firstProjectId,
      name: 'Will Gravina',
      email,
      verifiedAt: null,
      createdAt: new Date()
    })
    if (first.isFailure()) throw new Error('unreachable')
    const firstResult = await repository.create({ senderIdentity: first.value })
    expect(firstResult.isSuccess()).toBe(true)

    const second = SenderIdentity.create({
      id: validId(),
      projectId: secondProjectId,
      name: 'Someone Else',
      email,
      verifiedAt: null,
      createdAt: new Date()
    })
    if (second.isFailure()) throw new Error('unreachable')
    const secondResult = await repository.create({ senderIdentity: second.value })

    expect(secondResult.isFailure()).toBe(true)
    if (secondResult.isFailure()) expect(secondResult.value.name).toBe('DuplicateSenderIdentityEmailError')
  })

  it('findUnverified only returns rows with verifiedAt IS NULL', async () => {
    const projectId = await seedProject()

    const unverified = SenderIdentity.create({
      id: validId(),
      projectId,
      name: 'Unverified',
      email: `unverified+${randomUUID()}@gravina.dev`,
      verifiedAt: null,
      createdAt: new Date()
    })
    if (unverified.isFailure()) throw new Error('unreachable')
    await repository.create({ senderIdentity: unverified.value })

    const verified = SenderIdentity.create({
      id: validId(),
      projectId,
      name: 'Verified',
      email: `verified+${randomUUID()}@gravina.dev`,
      verifiedAt: new Date(),
      createdAt: new Date()
    })
    if (verified.isFailure()) throw new Error('unreachable')
    const verifiedCreated = await repository.create({ senderIdentity: verified.value })
    if (verifiedCreated.isFailure()) throw new Error('unreachable')

    const result = await repository.findUnverified()

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      const ids = result.value.senderIdentities.map((s) => s.id.toString())
      expect(ids).toContain(unverified.value.id.toString())
      expect(ids).not.toContain(verifiedCreated.value.id.toString())
    }
  })

  it('markVerified sets verifiedAt so a subsequent findById reflects it', async () => {
    const projectId = await seedProject()
    const senderIdentity = SenderIdentity.create({
      id: validId(),
      projectId,
      name: 'To Verify',
      email: `to-verify+${randomUUID()}@gravina.dev`,
      verifiedAt: null,
      createdAt: new Date()
    })
    if (senderIdentity.isFailure()) throw new Error('unreachable')
    const created = await repository.create({ senderIdentity: senderIdentity.value })
    if (created.isFailure()) throw new Error('unreachable')

    const verifiedAt = new Date()
    const markResult = await repository.markVerified({ id: created.value.id.toString(), verifiedAt })
    expect(markResult.isSuccess()).toBe(true)

    const found = await repository.findById({ id: created.value.id.toString() })
    expect(found.isSuccess()).toBe(true)
    if (found.isSuccess()) expect(found.value.senderIdentity?.isVerified()).toBe(true)
  })
})
```

Run: `pnpm --filter @ruguin/core-server test:integration -- sender-identity.repository.int`
Expected: PASS (3 tests). Requires `docker compose up -d` (Postgres) — same requirement as every
other `.int.ts` file in this app.

- [ ] **Step 9: Run the full core-server test suite and type check**

Run: `pnpm --filter @ruguin/core-server test && pnpm --filter @ruguin/core-server check:types`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/core-server/prisma apps/core-server/src/modules/sender-identities
git commit -m "feat(core-server): sender_identities table and SenderIdentityRepository"
```

---

### Task 4: `SesIdentityProvider` — AWS SES v2 adapter

**Files:**

- Modify: `apps/core-server/package.json` (new dependency)
- Modify: `packages/env/src/apps/core-server.environment.ts`
- Modify: `packages/env/src/apps/__tests__/core-server.environment.unit.ts`
- Create: `apps/core-server/src/modules/sender-identities/domain/errors/create-ses-identity.error.ts`
- Create: `apps/core-server/src/modules/sender-identities/domain/errors/check-ses-identity.error.ts`
- Create: `apps/core-server/src/modules/sender-identities/domain/contracts/providers/ses-identity.provider.ts`
- Create: `apps/core-server/src/modules/sender-identities/infrastructure/aws/ses-v2-client.provider.ts`
- Create: `apps/core-server/src/modules/sender-identities/infrastructure/aws/ses-identity.provider.ts`
- Test: `apps/core-server/src/modules/sender-identities/infrastructure/aws/__tests__/ses-identity.provider.unit.ts`
- Create: `apps/core-server/src/modules/sender-identities/sender-identities.module.ts`

**Interfaces:**

- Consumes: `awsENV` (Task 1).
- Produces: `SES_IDENTITY_PROVIDER` token and `SesIdentityProvider` contract —
  `createIdentity({email})`, `getVerificationStatus({email})` — consumed by Task 6 (register use
  case), Task 7 (sync use case).

- [ ] **Step 1: Add the new AWS SDK dependency**

In `apps/core-server/package.json`'s `dependencies`, add (alphabetically, matching
`apps/dispatch-worker/package.json`'s pin style for `@aws-sdk/client-ses`):

```json
"@aws-sdk/client-sesv2": "^3.700.0",
```

Run: `pnpm install`

- [ ] **Step 2: `coreServerENV` extends `awsENV`**

In `packages/env/src/apps/core-server.environment.ts`, add the import and extend entry:

```ts
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { awsENV } from '../packages/aws.environment.ts'
import { cacheENV } from '../packages/cache.environment.ts'
import { databaseENV } from '../packages/database.environment.ts'
import { docsENV } from '../packages/docs.environment.ts'
import { messageBrokerENV } from '../packages/message-broker.environment.ts'
import { lazyEnvironment } from '../shared/lazy-environment.ts'
import { serverENV } from '../shared/server.environment.ts'

export const coreServerENV = lazyEnvironment(() =>
  createEnv({
    server: {
      API_KEY_CACHE_TTL_IN_SECONDS: z.coerce.number().int().positive().default(300)
    },
    extends: [serverENV, databaseENV, cacheENV, messageBrokerENV, docsENV, awsENV],
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
```

In `packages/env/src/apps/__tests__/core-server.environment.unit.ts`, add one assertion to the
`'exposes every field from each extended package'` test, right after the `docsENV` block:

```ts
    // awsENV
    expect(coreServerENV.AWS_REGION).toBe('us-east-1')
```

Run: `pnpm --filter @ruguin/env test:unit`
Expected: PASS — `awsENV`'s only field without a default (`AWS_ENDPOINT_URL`,
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) are all `.optional()`, so extending it adds no new
required variable and `MINIMUM_REQUIRED_ENVIRONMENT` needs no change.

- [ ] **Step 3: Write the two error classes**

Create `apps/core-server/src/modules/sender-identities/domain/errors/create-ses-identity.error.ts`:

```ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class CreateSesIdentityError extends BaseError {
  readonly name = 'CreateSesIdentityError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to register the sender identity with SES.' })
  }
}
```

Create `apps/core-server/src/modules/sender-identities/domain/errors/check-ses-identity.error.ts`:

```ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class CheckSesIdentityError extends BaseError {
  readonly name = 'CheckSesIdentityError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to check the SES verification status.' })
  }
}
```

- [ ] **Step 4: Write the failing provider unit test**

Create `apps/core-server/src/modules/sender-identities/infrastructure/aws/__tests__/ses-identity.provider.unit.ts`:

```ts
import { type SESv2Client } from '@aws-sdk/client-sesv2'
import { describe, expect, it, vi } from 'vitest'

import { AwsSesIdentityProvider } from '../ses-identity.provider'

describe('AwsSesIdentityProvider', () => {
  describe('createIdentity', () => {
    it('calls CreateEmailIdentityCommand with the given email', async () => {
      const send = vi.fn().mockResolvedValue({})
      const client = { send } as unknown as SESv2Client
      const provider = new AwsSesIdentityProvider(client)

      const result = await provider.createIdentity({ email: 'will@gravina.dev' })

      expect(result.isSuccess()).toBe(true)
      expect(send).toHaveBeenCalledTimes(1)
      const [command] = send.mock.calls[0] as [{ input: { EmailIdentity: string } }]
      expect(command.input).toEqual({ EmailIdentity: 'will@gravina.dev' })
    })

    it('maps a rejected send() into CreateSesIdentityError', async () => {
      const send = vi.fn().mockRejectedValue(new Error('rate limited'))
      const client = { send } as unknown as SESv2Client
      const provider = new AwsSesIdentityProvider(client)

      const result = await provider.createIdentity({ email: 'will@gravina.dev' })

      expect(result.isFailure()).toBe(true)
      if (result.isFailure()) expect(result.value.name).toBe('CreateSesIdentityError')
    })
  })

  describe('getVerificationStatus', () => {
    it('reports verified: true when SES reports VerifiedForSendingStatus true', async () => {
      const send = vi.fn().mockResolvedValue({ VerifiedForSendingStatus: true })
      const client = { send } as unknown as SESv2Client
      const provider = new AwsSesIdentityProvider(client)

      const result = await provider.getVerificationStatus({ email: 'will@gravina.dev' })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value.verified).toBe(true)
    })

    it('reports verified: false when SES reports VerifiedForSendingStatus false or absent', async () => {
      const send = vi.fn().mockResolvedValue({ VerifiedForSendingStatus: false })
      const client = { send } as unknown as SESv2Client
      const provider = new AwsSesIdentityProvider(client)

      const result = await provider.getVerificationStatus({ email: 'will@gravina.dev' })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value.verified).toBe(false)
    })

    it('maps a rejected send() into CheckSesIdentityError', async () => {
      const send = vi.fn().mockRejectedValue(new Error('not found'))
      const client = { send } as unknown as SESv2Client
      const provider = new AwsSesIdentityProvider(client)

      const result = await provider.getVerificationStatus({ email: 'will@gravina.dev' })

      expect(result.isFailure()).toBe(true)
      if (result.isFailure()) expect(result.value.name).toBe('CheckSesIdentityError')
    })
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm --filter @ruguin/core-server test -- ses-identity.provider.unit`
Expected: FAIL — `../ses-identity.provider` does not exist yet.

- [ ] **Step 6: Write the contract**

Create `apps/core-server/src/modules/sender-identities/domain/contracts/providers/ses-identity.provider.ts`:

```ts
import { type Either } from '@ruguin/utils'

import { type CheckSesIdentityError } from '../../errors/check-ses-identity.error'
import { type CreateSesIdentityError } from '../../errors/create-ses-identity.error'

export const SES_IDENTITY_PROVIDER = Symbol('SES_IDENTITY_PROVIDER')

export interface SesIdentityProvider {
  createIdentity(input: { email: string }): Promise<Either<CreateSesIdentityError, void>>
  getVerificationStatus(input: { email: string }): Promise<Either<CheckSesIdentityError, { verified: boolean }>>
}
```

- [ ] **Step 7: Write the SESv2Client provider**

Create `apps/core-server/src/modules/sender-identities/infrastructure/aws/ses-v2-client.provider.ts`:

```ts
import { SESv2Client } from '@aws-sdk/client-sesv2'
import { type Provider } from '@nestjs/common'
import { awsENV } from '@ruguin/env'

export const sesV2ClientProvider: Provider = {
  provide: SESv2Client,
  useFactory: (): SESv2Client =>
    new SESv2Client({
      region: awsENV.AWS_REGION,
      ...(awsENV.AWS_ENDPOINT_URL !== undefined && { endpoint: awsENV.AWS_ENDPOINT_URL }),
      /*
       * Static credentials are for LocalStack only — same pattern and rationale as
       * apps/dispatch-worker/src/email/infra/ses/ses-client.provider.ts: omitting `credentials`
       * falls through to the SDK's default credential provider chain in a real deployment.
       */
      ...(awsENV.AWS_ACCESS_KEY_ID !== undefined &&
        awsENV.AWS_SECRET_ACCESS_KEY !== undefined && {
          credentials: { accessKeyId: awsENV.AWS_ACCESS_KEY_ID, secretAccessKey: awsENV.AWS_SECRET_ACCESS_KEY }
        })
    })
}
```

- [ ] **Step 8: Write the adapter**

Create `apps/core-server/src/modules/sender-identities/infrastructure/aws/ses-identity.provider.ts`:

```ts
import { CreateEmailIdentityCommand, GetEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2'
import { Injectable } from '@nestjs/common'
import { type Either, failure, success } from '@ruguin/utils'

import { type SesIdentityProvider as SesIdentityProviderContract } from '../../domain/contracts/providers/ses-identity.provider'
import { CheckSesIdentityError } from '../../domain/errors/check-ses-identity.error'
import { CreateSesIdentityError } from '../../domain/errors/create-ses-identity.error'

@Injectable()
export class AwsSesIdentityProvider implements SesIdentityProviderContract {
  constructor(private readonly client: SESv2Client) {}

  public async createIdentity(input: { email: string }): Promise<Either<CreateSesIdentityError, void>> {
    try {
      await this.client.send(new CreateEmailIdentityCommand({ EmailIdentity: input.email }))
      return success(undefined)
    } catch (error: unknown) {
      return failure(new CreateSesIdentityError({ error }))
    }
  }

  public async getVerificationStatus(input: {
    email: string
  }): Promise<Either<CheckSesIdentityError, { verified: boolean }>> {
    try {
      const response = await this.client.send(new GetEmailIdentityCommand({ EmailIdentity: input.email }))
      return success({ verified: response.VerifiedForSendingStatus === true })
    } catch (error: unknown) {
      return failure(new CheckSesIdentityError({ error }))
    }
  }
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- ses-identity.provider.unit`
Expected: PASS (5 tests).

- [ ] **Step 10: Create the module, wiring the repository and SES provider**

Create `apps/core-server/src/modules/sender-identities/sender-identities.module.ts`:

```ts
import { Module } from '@nestjs/common'

import { SES_IDENTITY_PROVIDER } from './domain/contracts/providers/ses-identity.provider'
import { SENDER_IDENTITY_REPOSITORY } from './domain/contracts/repositories/sender-identity.repository'
import { AwsSesIdentityProvider } from './infrastructure/aws/ses-identity.provider'
import { sesV2ClientProvider } from './infrastructure/aws/ses-v2-client.provider'
import { SenderIdentityRepository } from './infrastructure/database/prisma/sender-identity.repository'

@Module({
  providers: [
    SenderIdentityRepository,
    { provide: SENDER_IDENTITY_REPOSITORY, useExisting: SenderIdentityRepository },
    sesV2ClientProvider,
    AwsSesIdentityProvider,
    { provide: SES_IDENTITY_PROVIDER, useExisting: AwsSesIdentityProvider }
  ],
  exports: [SENDER_IDENTITY_REPOSITORY, SES_IDENTITY_PROVIDER]
})
export class SenderIdentitiesModule {}
```

This module is extended in Tasks 5, 6, 7, and 8 as each adds its own providers/controllers — it is
not registered anywhere the app can reach yet (no controller, not imported by `RouterModule`) until
Task 8.

- [ ] **Step 11: Run the full core-server test suite and type check**

Run: `pnpm --filter @ruguin/core-server test && pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/env test:unit`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add apps/core-server packages/env
git commit -m "feat(core-server): AWS SES v2 identity provider"
```

---

### Task 5: `SenderIdentityCacheProvider`

**Files:**

- Modify: `packages/env/src/apps/core-server.environment.ts`
- Modify: `packages/env/src/apps/__tests__/core-server.environment.unit.ts`
- Create: `apps/core-server/src/modules/sender-identities/domain/contracts/sender-identity-cache.provider.ts`
- Create: `apps/core-server/src/modules/sender-identities/infrastructure/cache/sender-identity-cache.provider.ts`
- Test: `apps/core-server/src/modules/sender-identities/infrastructure/cache/__tests__/sender-identity-cache.provider.unit.ts`
- Modify: `apps/core-server/src/modules/sender-identities/sender-identities.module.ts`

**Interfaces:**

- Consumes: `SENDER_IDENTITY_REPOSITORY` (Task 3), `GET_OR_SET_CACHE_PROVIDER`/`DELETE_CACHE_PROVIDER`
  (`@ruguin/cache`, already wired globally in `app.module.ts` via `CacheModule.forRoot`).
- Produces: `SENDER_IDENTITY_CACHE_PROVIDER` token and `SenderIdentityCacheProvider` contract —
  `get({senderIdentityId})`, `invalidate({senderIdentityId})` — consumed by Task 7 (sync use case
  calls `invalidate`), Task 11 (`SendEmailUseCase` calls `get`).

- [ ] **Step 1: Add `SENDER_IDENTITY_CACHE_TTL_IN_SECONDS` to `coreServerENV`**

In `packages/env/src/apps/core-server.environment.ts`, extend the `server` block:

```ts
    server: {
      API_KEY_CACHE_TTL_IN_SECONDS: z.coerce.number().int().positive().default(300),
      SENDER_IDENTITY_CACHE_TTL_IN_SECONDS: z.coerce.number().int().positive().default(300)
    },
```

In `packages/env/src/apps/__tests__/core-server.environment.unit.ts`, add a new `describe` block
mirroring the existing `'coreServerENV.API_KEY_CACHE_TTL_IN_SECONDS'` one, placed right after it:

```ts
describe('coreServerENV.SENDER_IDENTITY_CACHE_TTL_IN_SECONDS', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    process.env.ENVIRONMENT = 'test'
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    process.env.CACHE_PREFIX = 'ruguin:core-server'
    process.env.KAFKA_BOOTSTRAP_BROKERS = 'localhost:9092'
    process.env.DOCS_USERNAME = 'docs'
    process.env.DOCS_PASSWORD = 'docs'
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('defaults to 300 when unset', async () => {
    delete process.env.SENDER_IDENTITY_CACHE_TTL_IN_SECONDS
    const { coreServerENV } = await import('../core-server.environment.ts')

    expect(coreServerENV.SENDER_IDENTITY_CACHE_TTL_IN_SECONDS).toBe(300)
  })

  it('reads a positive integer override from the environment', async () => {
    process.env.SENDER_IDENTITY_CACHE_TTL_IN_SECONDS = '120'
    const { coreServerENV } = await import('../core-server.environment.ts')

    expect(coreServerENV.SENDER_IDENTITY_CACHE_TTL_IN_SECONDS).toBe(120)
  })
})
```

Run: `pnpm --filter @ruguin/env test:unit`
Expected: PASS.

- [ ] **Step 2: Write the failing cache provider unit test**

Create `apps/core-server/src/modules/sender-identities/infrastructure/cache/__tests__/sender-identity-cache.provider.unit.ts`:

```ts
import { CacheLockOutcome, CacheSource, type IDeleteCacheProvider, type IGetOrSetCacheProvider } from '@ruguin/cache'
import { ID } from '@ruguin/shared-domain'
import { failure, success } from '@ruguin/utils'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { type SenderIdentityRepository } from '../../../domain/contracts/repositories/sender-identity.repository'
import { FindSenderIdentityError } from '../../../domain/errors/find-sender-identity.error'
import { SenderIdentity } from '../../../domain/models/sender-identity.model'
import { SenderIdentityCacheProvider } from '../sender-identity-cache.provider'

/*
 * The provider reads coreServerENV.SENDER_IDENTITY_CACHE_TTL_IN_SECONDS on every call, and
 * coreServerENV is one combined schema validated in full on first property access — same reasoning
 * as api-key-auth.guard.unit.ts's own beforeAll block.
 */
beforeAll(() => {
  vi.stubEnv('ENVIRONMENT', 'test')
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/ruguin?schema=core_server')
  vi.stubEnv('CACHE_PREFIX', 'ruguin:core-server')
  vi.stubEnv('KAFKA_BOOTSTRAP_BROKERS', 'localhost:9092')
  vi.stubEnv('DOCS_USERNAME', 'admin')
  vi.stubEnv('DOCS_PASSWORD', 'super-secret')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

function validId(): ID {
  const generated = ID.generate({ modelName: 'SenderIdentity' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildSenderIdentity() {
  const result = SenderIdentity.create({
    id: validId(),
    projectId: 'project-1',
    name: 'Will Gravina',
    email: 'will@gravina.dev',
    verifiedAt: null,
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

function createGetOrSetStub(): IGetOrSetCacheProvider {
  return {
    getOrSet: vi.fn(async ({ loader }) => {
      const loaded = await loader()
      if (loaded.isFailure()) return failure(loaded.value)

      return success({ value: loaded.value, source: CacheSource.LOADER, lockOutcome: CacheLockOutcome.NOT_ATTEMPTED })
    })
  } as unknown as IGetOrSetCacheProvider
}

describe('SenderIdentityCacheProvider', () => {
  describe('get', () => {
    it('runs the loader through getOrSet, keyed by the sender identity id, with a colon-free namespace', async () => {
      const senderIdentity = buildSenderIdentity()
      const repository = {
        findById: vi.fn().mockResolvedValue(success({ senderIdentity }))
      } as unknown as SenderIdentityRepository
      const getOrSetCache = createGetOrSetStub()
      const deleteCache = { delete: vi.fn() } as unknown as IDeleteCacheProvider
      const cacheProvider = new SenderIdentityCacheProvider(repository, getOrSetCache, deleteCache)

      const result = await cacheProvider.get({ senderIdentityId: senderIdentity.id.toString() })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value?.email).toBe('will@gravina.dev')
      const [options] = (getOrSetCache.getOrSet as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { key: string; namespace: string; ttlInMs: number }
      ]
      expect(options.key).toBe(senderIdentity.id.toString())
      expect(options.namespace).not.toMatch(/[\s:]/)
      expect(Number.isSafeInteger(options.ttlInMs)).toBe(true)
    })

    it('propagates a repository failure through the loader', async () => {
      const repository = {
        findById: vi.fn().mockResolvedValue(failure(new FindSenderIdentityError({})))
      } as unknown as SenderIdentityRepository
      const getOrSetCache = createGetOrSetStub()
      const deleteCache = { delete: vi.fn() } as unknown as IDeleteCacheProvider
      const cacheProvider = new SenderIdentityCacheProvider(repository, getOrSetCache, deleteCache)

      const result = await cacheProvider.get({ senderIdentityId: 'sender-1' })

      expect(result.isFailure()).toBe(true)
      if (result.isFailure()) expect(result.value).toBeInstanceOf(FindSenderIdentityError)
    })

    it('resolves null when the repository finds no matching row', async () => {
      const repository = {
        findById: vi.fn().mockResolvedValue(success({ senderIdentity: null }))
      } as unknown as SenderIdentityRepository
      const getOrSetCache = createGetOrSetStub()
      const deleteCache = { delete: vi.fn() } as unknown as IDeleteCacheProvider
      const cacheProvider = new SenderIdentityCacheProvider(repository, getOrSetCache, deleteCache)

      const result = await cacheProvider.get({ senderIdentityId: 'unknown' })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value).toBeNull()
    })
  })

  describe('invalidate', () => {
    it('calls delete with the same namespace used by get', async () => {
      const repository = { findById: vi.fn() } as unknown as SenderIdentityRepository
      const getOrSetCache = { getOrSet: vi.fn() } as unknown as IGetOrSetCacheProvider
      const deleteFn = vi.fn().mockResolvedValue(success({ existed: true }))
      const deleteCache = { delete: deleteFn } as unknown as IDeleteCacheProvider
      const cacheProvider = new SenderIdentityCacheProvider(repository, getOrSetCache, deleteCache)

      await cacheProvider.invalidate({ senderIdentityId: 'sender-1' })

      expect(deleteFn).toHaveBeenCalledWith({ key: 'sender-1', namespace: 'core-server-sender-identity' })
    })
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @ruguin/core-server test -- sender-identity-cache.provider.unit`
Expected: FAIL — `../sender-identity-cache.provider` does not exist yet.

- [ ] **Step 4: Write the contract**

Create `apps/core-server/src/modules/sender-identities/domain/contracts/sender-identity-cache.provider.ts`:

```ts
import { type Either } from '@ruguin/utils'

import { type FindSenderIdentityError } from '../errors/find-sender-identity.error'
import { type SenderIdentity } from '../models/sender-identity.model'

export const SENDER_IDENTITY_CACHE_PROVIDER = Symbol('SENDER_IDENTITY_CACHE_PROVIDER')

export interface SenderIdentityCacheProvider {
  get(input: { senderIdentityId: string }): Promise<Either<FindSenderIdentityError, SenderIdentity | null>>
  invalidate(input: { senderIdentityId: string }): Promise<void>
}
```

- [ ] **Step 5: Write the implementation**

Create `apps/core-server/src/modules/sender-identities/infrastructure/cache/sender-identity-cache.provider.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'
import {
  DELETE_CACHE_PROVIDER,
  GET_OR_SET_CACHE_PROVIDER,
  type IDeleteCacheProvider,
  type IGetOrSetCacheProvider
} from '@ruguin/cache'
import { coreServerENV } from '@ruguin/env'
import { type Either, failure, success } from '@ruguin/utils'

import {
  SENDER_IDENTITY_REPOSITORY,
  type SenderIdentityRepository
} from '../../domain/contracts/repositories/sender-identity.repository'
import { type SenderIdentityCacheProvider as SenderIdentityCacheProviderContract } from '../../domain/contracts/sender-identity-cache.provider'
import { type FindSenderIdentityError } from '../../domain/errors/find-sender-identity.error'
import { type SenderIdentity } from '../../domain/models/sender-identity.model'

// KeyBuilder.validateSegment forbids ':' in namespace/key segments — see packages/cache/src/infra/key-builder.ts.
const CACHE_NAMESPACE = 'core-server-sender-identity'

@Injectable()
export class SenderIdentityCacheProvider implements SenderIdentityCacheProviderContract {
  constructor(
    @Inject(SENDER_IDENTITY_REPOSITORY) private readonly repository: SenderIdentityRepository,
    @Inject(GET_OR_SET_CACHE_PROVIDER) private readonly getOrSetCache: IGetOrSetCacheProvider,
    @Inject(DELETE_CACHE_PROVIDER) private readonly deleteCache: IDeleteCacheProvider
  ) {}

  public async get(input: {
    senderIdentityId: string
  }): Promise<Either<FindSenderIdentityError, SenderIdentity | null>> {
    const cached = await this.getOrSetCache.getOrSet<SenderIdentity, FindSenderIdentityError>({
      key: input.senderIdentityId,
      namespace: CACHE_NAMESPACE,
      ttlInMs: coreServerENV.SENDER_IDENTITY_CACHE_TTL_IN_SECONDS * 1000,
      loader: async () => {
        const result = await this.repository.findById({ id: input.senderIdentityId })
        if (result.isFailure()) return failure(result.value)
        return success(result.value.senderIdentity)
      }
    })

    if (cached.isFailure()) return failure(cached.value)
    return success(cached.value.value)
  }

  public async invalidate(input: { senderIdentityId: string }): Promise<void> {
    /*
     * Fire-and-forget: Postgres (via markVerified, Task 7) is already the source of truth by the
     * time this runs. A failed cache delete just means the stale value survives until its own TTL
     * expires — not incorrect data loss — so it must not fail whatever caller triggered it.
     */
    await this.deleteCache.delete({ key: input.senderIdentityId, namespace: CACHE_NAMESPACE })
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- sender-identity-cache.provider.unit`
Expected: PASS (4 tests).

- [ ] **Step 7: Wire the cache provider into the module**

Replace the full contents of `apps/core-server/src/modules/sender-identities/sender-identities.module.ts`:

```ts
import { Module } from '@nestjs/common'

import { SES_IDENTITY_PROVIDER } from './domain/contracts/providers/ses-identity.provider'
import { SENDER_IDENTITY_REPOSITORY } from './domain/contracts/repositories/sender-identity.repository'
import { SENDER_IDENTITY_CACHE_PROVIDER } from './domain/contracts/sender-identity-cache.provider'
import { AwsSesIdentityProvider } from './infrastructure/aws/ses-identity.provider'
import { sesV2ClientProvider } from './infrastructure/aws/ses-v2-client.provider'
import { SenderIdentityCacheProvider } from './infrastructure/cache/sender-identity-cache.provider'
import { SenderIdentityRepository } from './infrastructure/database/prisma/sender-identity.repository'

@Module({
  providers: [
    SenderIdentityRepository,
    { provide: SENDER_IDENTITY_REPOSITORY, useExisting: SenderIdentityRepository },
    sesV2ClientProvider,
    AwsSesIdentityProvider,
    { provide: SES_IDENTITY_PROVIDER, useExisting: AwsSesIdentityProvider },
    SenderIdentityCacheProvider,
    { provide: SENDER_IDENTITY_CACHE_PROVIDER, useExisting: SenderIdentityCacheProvider }
  ],
  exports: [SENDER_IDENTITY_REPOSITORY, SES_IDENTITY_PROVIDER, SENDER_IDENTITY_CACHE_PROVIDER]
})
export class SenderIdentitiesModule {}
```

- [ ] **Step 8: Run the full core-server test suite and type check**

Run: `pnpm --filter @ruguin/core-server test && pnpm --filter @ruguin/core-server check:types`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/core-server packages/env
git commit -m "feat(core-server): SenderIdentityCacheProvider"
```

---

### Task 6: `RegisterSenderIdentityUseCase` + `ListSenderIdentitiesUseCase`

**Files:**

- Create: `apps/core-server/src/modules/sender-identities/application/use-cases/register-sender-identity.use-case.ts`
- Test: `apps/core-server/src/modules/sender-identities/application/use-cases/__tests__/register-sender-identity.use-case.unit.ts`
- Create: `apps/core-server/src/modules/sender-identities/application/use-cases/list-sender-identities.use-case.ts`
- Test: `apps/core-server/src/modules/sender-identities/application/use-cases/__tests__/list-sender-identities.use-case.unit.ts`
- Modify: `apps/core-server/src/modules/sender-identities/sender-identities.module.ts`

**Interfaces:**

- Consumes: `SENDER_IDENTITY_REPOSITORY` (Task 3), `SES_IDENTITY_PROVIDER` (Task 4).
- Produces: `RegisterSenderIdentityUseCase#execute(input: {projectId, name, email}):
  Promise<Either<BaseError, SenderIdentity>>`, `ListSenderIdentitiesUseCase#execute(input:
  {projectId}): Promise<Either<FindSenderIdentityError, SenderIdentity[]>>` — both consumed by Task
  8's `SenderIdentityService`.

- [ ] **Step 1: Write the failing tests**

Create `apps/core-server/src/modules/sender-identities/application/use-cases/__tests__/register-sender-identity.use-case.unit.ts`:

```ts
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type SesIdentityProvider } from '../../../domain/contracts/providers/ses-identity.provider'
import { type SenderIdentityRepository } from '../../../domain/contracts/repositories/sender-identity.repository'
import { CreateSenderIdentityError } from '../../../domain/errors/create-sender-identity.error'
import { CreateSesIdentityError } from '../../../domain/errors/create-ses-identity.error'
import { InvalidSenderIdentityError } from '../../../domain/errors/invalid-sender-identity.error'
import { RegisterSenderIdentityUseCase } from '../register-sender-identity.use-case'

describe('RegisterSenderIdentityUseCase', () => {
  it('creates the row and registers it with SES', async () => {
    const create = vi.fn().mockImplementation(async ({ senderIdentity }) => success(senderIdentity))
    const repository = { create } as unknown as SenderIdentityRepository
    const createIdentity = vi.fn().mockResolvedValue(success(undefined))
    const sesIdentityProvider = { createIdentity } as unknown as SesIdentityProvider
    const useCase = new RegisterSenderIdentityUseCase(repository, sesIdentityProvider)

    const result = await useCase.execute({ projectId: 'project-1', name: 'Will Gravina', email: 'will@gravina.dev' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.email).toBe('will@gravina.dev')
      expect(result.value.verifiedAt).toBeNull()
    }
    expect(createIdentity).toHaveBeenCalledWith({ email: 'will@gravina.dev' })
  })

  it('fails with InvalidSenderIdentityError and never touches the repository or SES when name is empty', async () => {
    const create = vi.fn()
    const repository = { create } as unknown as SenderIdentityRepository
    const createIdentity = vi.fn()
    const sesIdentityProvider = { createIdentity } as unknown as SesIdentityProvider
    const useCase = new RegisterSenderIdentityUseCase(repository, sesIdentityProvider)

    const result = await useCase.execute({ projectId: 'project-1', name: '', email: 'will@gravina.dev' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(InvalidSenderIdentityError)
    expect(create).not.toHaveBeenCalled()
    expect(createIdentity).not.toHaveBeenCalled()
  })

  it('propagates a repository failure without calling SES', async () => {
    const repository = {
      create: vi.fn().mockResolvedValue(failure(new CreateSenderIdentityError({})))
    } as unknown as SenderIdentityRepository
    const createIdentity = vi.fn()
    const sesIdentityProvider = { createIdentity } as unknown as SesIdentityProvider
    const useCase = new RegisterSenderIdentityUseCase(repository, sesIdentityProvider)

    const result = await useCase.execute({ projectId: 'project-1', name: 'Will Gravina', email: 'will@gravina.dev' })

    expect(result.isFailure()).toBe(true)
    expect(createIdentity).not.toHaveBeenCalled()
  })

  it('propagates a SES failure after the row was already created', async () => {
    const create = vi.fn().mockImplementation(async ({ senderIdentity }) => success(senderIdentity))
    const repository = { create } as unknown as SenderIdentityRepository
    const createIdentity = vi.fn().mockResolvedValue(failure(new CreateSesIdentityError({})))
    const sesIdentityProvider = { createIdentity } as unknown as SesIdentityProvider
    const useCase = new RegisterSenderIdentityUseCase(repository, sesIdentityProvider)

    const result = await useCase.execute({ projectId: 'project-1', name: 'Will Gravina', email: 'will@gravina.dev' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(CreateSesIdentityError)
    expect(create).toHaveBeenCalledTimes(1)
  })
})
```

Create `apps/core-server/src/modules/sender-identities/application/use-cases/__tests__/list-sender-identities.use-case.unit.ts`:

```ts
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type SenderIdentityRepository } from '../../../domain/contracts/repositories/sender-identity.repository'
import { FindSenderIdentityError } from '../../../domain/errors/find-sender-identity.error'
import { ListSenderIdentitiesUseCase } from '../list-sender-identities.use-case'

describe('ListSenderIdentitiesUseCase', () => {
  it('returns the sender identities the repository finds for the project', async () => {
    const findManyByProjectId = vi.fn().mockResolvedValue(success({ senderIdentities: [] }))
    const repository = { findManyByProjectId } as unknown as SenderIdentityRepository
    const useCase = new ListSenderIdentitiesUseCase(repository)

    const result = await useCase.execute({ projectId: 'project-1' })

    expect(result.isSuccess()).toBe(true)
    expect(findManyByProjectId).toHaveBeenCalledWith({ projectId: 'project-1' })
  })

  it('propagates a repository failure', async () => {
    const repository = {
      findManyByProjectId: vi.fn().mockResolvedValue(failure(new FindSenderIdentityError({})))
    } as unknown as SenderIdentityRepository
    const useCase = new ListSenderIdentitiesUseCase(repository)

    const result = await useCase.execute({ projectId: 'project-1' })

    expect(result.isFailure()).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ruguin/core-server test -- sender-identit`
Expected: FAIL — neither use case file exists yet.

- [ ] **Step 3: Write `RegisterSenderIdentityUseCase`**

Create `apps/core-server/src/modules/sender-identities/application/use-cases/register-sender-identity.use-case.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'
import { type BaseError, ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { SES_IDENTITY_PROVIDER, type SesIdentityProvider } from '../../domain/contracts/providers/ses-identity.provider'
import {
  SENDER_IDENTITY_REPOSITORY,
  type SenderIdentityRepository
} from '../../domain/contracts/repositories/sender-identity.repository'
import { SenderIdentity } from '../../domain/models/sender-identity.model'

export type RegisterSenderIdentityUseCaseInput = Readonly<{ projectId: string; name: string; email: string }>

@Injectable()
export class RegisterSenderIdentityUseCase {
  constructor(
    @Inject(SENDER_IDENTITY_REPOSITORY) private readonly repository: SenderIdentityRepository,
    @Inject(SES_IDENTITY_PROVIDER) private readonly sesIdentityProvider: SesIdentityProvider
  ) {}

  public async execute(input: RegisterSenderIdentityUseCaseInput): Promise<Either<BaseError, SenderIdentity>> {
    const idGenerated = ID.generate({ modelName: 'SenderIdentity' })
    if (idGenerated.isFailure()) {
      /*
       * Same posture as SendEmailUseCase: UUID generation itself failing is treated as a bug, not
       * an expected domain failure — there is no meaningful recovery for the caller here.
       */
      throw new Error(`Failed to generate an id for a new sender identity: ${idGenerated.value.message}`)
    }

    const senderIdentityResult = SenderIdentity.create({
      id: idGenerated.value.idGenerated,
      projectId: input.projectId,
      name: input.name,
      email: input.email,
      verifiedAt: null,
      createdAt: new Date()
    })
    if (senderIdentityResult.isFailure()) return senderIdentityResult

    const created = await this.repository.create({ senderIdentity: senderIdentityResult.value })
    if (created.isFailure()) return failure(created.value)

    /*
     * Registered before SES confirms: the row is what GET /sender-identities lists back and what
     * Task 7's sync job polls for. A failed CreateEmailIdentity call here leaves the row stuck at
     * verifiedAt: null forever (Task 7 only checks status, never retries creation) — an accepted
     * risk documented in the design spec, not silently swallowed here.
     */
    const sesResult = await this.sesIdentityProvider.createIdentity({ email: created.value.email })
    if (sesResult.isFailure()) return failure(sesResult.value)

    return success(created.value)
  }
}
```

- [ ] **Step 4: Write `ListSenderIdentitiesUseCase`**

Create `apps/core-server/src/modules/sender-identities/application/use-cases/list-sender-identities.use-case.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'
import { type Either, failure, success } from '@ruguin/utils'

import {
  SENDER_IDENTITY_REPOSITORY,
  type SenderIdentityRepository
} from '../../domain/contracts/repositories/sender-identity.repository'
import { type FindSenderIdentityError } from '../../domain/errors/find-sender-identity.error'
import { type SenderIdentity } from '../../domain/models/sender-identity.model'

export type ListSenderIdentitiesUseCaseInput = Readonly<{ projectId: string }>

@Injectable()
export class ListSenderIdentitiesUseCase {
  constructor(@Inject(SENDER_IDENTITY_REPOSITORY) private readonly repository: SenderIdentityRepository) {}

  public async execute(
    input: ListSenderIdentitiesUseCaseInput
  ): Promise<Either<FindSenderIdentityError, SenderIdentity[]>> {
    const result = await this.repository.findManyByProjectId({ projectId: input.projectId })
    if (result.isFailure()) return failure(result.value)

    return success(result.value.senderIdentities)
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ruguin/core-server test -- sender-identit`
Expected: PASS (6 tests).

- [ ] **Step 6: Wire both use cases into the module**

In `apps/core-server/src/modules/sender-identities/sender-identities.module.ts`, add the two use
case imports and add them to `providers` (no export needed — Task 8's `SenderIdentityService`, in
the same module, injects them directly):

```ts
import { Module } from '@nestjs/common'

import { RegisterSenderIdentityUseCase } from './application/use-cases/register-sender-identity.use-case'
import { ListSenderIdentitiesUseCase } from './application/use-cases/list-sender-identities.use-case'
import { SES_IDENTITY_PROVIDER } from './domain/contracts/providers/ses-identity.provider'
import { SENDER_IDENTITY_REPOSITORY } from './domain/contracts/repositories/sender-identity.repository'
import { SENDER_IDENTITY_CACHE_PROVIDER } from './domain/contracts/sender-identity-cache.provider'
import { AwsSesIdentityProvider } from './infrastructure/aws/ses-identity.provider'
import { sesV2ClientProvider } from './infrastructure/aws/ses-v2-client.provider'
import { SenderIdentityCacheProvider } from './infrastructure/cache/sender-identity-cache.provider'
import { SenderIdentityRepository } from './infrastructure/database/prisma/sender-identity.repository'

@Module({
  providers: [
    SenderIdentityRepository,
    { provide: SENDER_IDENTITY_REPOSITORY, useExisting: SenderIdentityRepository },
    sesV2ClientProvider,
    AwsSesIdentityProvider,
    { provide: SES_IDENTITY_PROVIDER, useExisting: AwsSesIdentityProvider },
    SenderIdentityCacheProvider,
    { provide: SENDER_IDENTITY_CACHE_PROVIDER, useExisting: SenderIdentityCacheProvider },
    RegisterSenderIdentityUseCase,
    ListSenderIdentitiesUseCase
  ],
  exports: [SENDER_IDENTITY_REPOSITORY, SES_IDENTITY_PROVIDER, SENDER_IDENTITY_CACHE_PROVIDER]
})
export class SenderIdentitiesModule {}
```

- [ ] **Step 7: Run the full core-server test suite and type check**

Run: `pnpm --filter @ruguin/core-server test && pnpm --filter @ruguin/core-server check:types`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/core-server
git commit -m "feat(core-server): register and list sender identity use cases"
```

---

### Task 7: `SyncSenderIdentityVerificationUseCase` + `SenderIdentitySyncService` (polling job)

**Files:**

- Create: `apps/core-server/src/modules/sender-identities/application/use-cases/sync-sender-identity-verification.use-case.ts`
- Test: `apps/core-server/src/modules/sender-identities/application/use-cases/__tests__/sync-sender-identity-verification.use-case.unit.ts`
- Create: `apps/core-server/src/modules/sender-identities/infrastructure/jobs/sender-identity-sync.service.ts`
- Test: `apps/core-server/src/modules/sender-identities/infrastructure/jobs/__tests__/sender-identity-sync.service.unit.ts`
- Modify: `apps/core-server/src/modules/sender-identities/sender-identities.module.ts`

**Interfaces:**

- Consumes: `SENDER_IDENTITY_REPOSITORY` (Task 3), `SES_IDENTITY_PROVIDER` (Task 4),
  `SENDER_IDENTITY_CACHE_PROVIDER` (Task 5).
- Produces: `SyncSenderIdentityVerificationUseCase#execute(): Promise<void>` — never throws, every
  branch logs and returns.

- [ ] **Step 1: Write the failing use case test**

Create `apps/core-server/src/modules/sender-identities/application/use-cases/__tests__/sync-sender-identity-verification.use-case.unit.ts`:

```ts
import { ID } from '@ruguin/shared-domain'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type SesIdentityProvider } from '../../../domain/contracts/providers/ses-identity.provider'
import { type SenderIdentityRepository } from '../../../domain/contracts/repositories/sender-identity.repository'
import { type SenderIdentityCacheProvider } from '../../../domain/contracts/sender-identity-cache.provider'
import { CheckSesIdentityError } from '../../../domain/errors/check-ses-identity.error'
import { FindSenderIdentityError } from '../../../domain/errors/find-sender-identity.error'
import { SenderIdentity } from '../../../domain/models/sender-identity.model'
import { SyncSenderIdentityVerificationUseCase } from '../sync-sender-identity-verification.use-case'

function validId(): ID {
  const generated = ID.generate({ modelName: 'SenderIdentity' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildSenderIdentity(email: string) {
  const result = SenderIdentity.create({
    id: validId(),
    projectId: 'project-1',
    name: 'Will Gravina',
    email,
    verifiedAt: null,
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

describe('SyncSenderIdentityVerificationUseCase', () => {
  it('marks a sender identity verified and invalidates its cache entry once SES confirms', async () => {
    const senderIdentity = buildSenderIdentity('will@gravina.dev')
    const repository = {
      findUnverified: vi.fn().mockResolvedValue(success({ senderIdentities: [senderIdentity] })),
      markVerified: vi.fn().mockResolvedValue(success(undefined))
    } as unknown as SenderIdentityRepository
    const sesIdentityProvider = {
      getVerificationStatus: vi.fn().mockResolvedValue(success({ verified: true }))
    } as unknown as SesIdentityProvider
    const invalidate = vi.fn().mockResolvedValue(undefined)
    const cache = { invalidate } as unknown as SenderIdentityCacheProvider
    const useCase = new SyncSenderIdentityVerificationUseCase(repository, sesIdentityProvider, cache)

    await useCase.execute()

    expect(repository.markVerified).toHaveBeenCalledWith({
      id: senderIdentity.id.toString(),
      verifiedAt: expect.any(Date)
    })
    expect(invalidate).toHaveBeenCalledWith({ senderIdentityId: senderIdentity.id.toString() })
  })

  it('does not mark verified or invalidate the cache when SES still reports unverified', async () => {
    const senderIdentity = buildSenderIdentity('will@gravina.dev')
    const repository = {
      findUnverified: vi.fn().mockResolvedValue(success({ senderIdentities: [senderIdentity] })),
      markVerified: vi.fn()
    } as unknown as SenderIdentityRepository
    const sesIdentityProvider = {
      getVerificationStatus: vi.fn().mockResolvedValue(success({ verified: false }))
    } as unknown as SesIdentityProvider
    const invalidate = vi.fn()
    const cache = { invalidate } as unknown as SenderIdentityCacheProvider
    const useCase = new SyncSenderIdentityVerificationUseCase(repository, sesIdentityProvider, cache)

    await useCase.execute()

    expect(repository.markVerified).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('keeps checking the remaining identities when one SES call fails', async () => {
    const first = buildSenderIdentity('first@gravina.dev')
    const second = buildSenderIdentity('second@gravina.dev')
    const repository = {
      findUnverified: vi.fn().mockResolvedValue(success({ senderIdentities: [first, second] })),
      markVerified: vi.fn().mockResolvedValue(success(undefined))
    } as unknown as SenderIdentityRepository
    const getVerificationStatus = vi
      .fn()
      .mockResolvedValueOnce(failure(new CheckSesIdentityError({})))
      .mockResolvedValueOnce(success({ verified: true }))
    const sesIdentityProvider = { getVerificationStatus } as unknown as SesIdentityProvider
    const invalidate = vi.fn().mockResolvedValue(undefined)
    const cache = { invalidate } as unknown as SenderIdentityCacheProvider
    const useCase = new SyncSenderIdentityVerificationUseCase(repository, sesIdentityProvider, cache)

    await useCase.execute()

    expect(getVerificationStatus).toHaveBeenCalledTimes(2)
    expect(repository.markVerified).toHaveBeenCalledTimes(1)
    expect(repository.markVerified).toHaveBeenCalledWith({ id: second.id.toString(), verifiedAt: expect.any(Date) })
  })

  it('does nothing and does not throw when findUnverified itself fails', async () => {
    const repository = {
      findUnverified: vi.fn().mockResolvedValue(failure(new FindSenderIdentityError({}))),
      markVerified: vi.fn()
    } as unknown as SenderIdentityRepository
    const getVerificationStatus = vi.fn()
    const sesIdentityProvider = { getVerificationStatus } as unknown as SesIdentityProvider
    const cache = { invalidate: vi.fn() } as unknown as SenderIdentityCacheProvider
    const useCase = new SyncSenderIdentityVerificationUseCase(repository, sesIdentityProvider, cache)

    await expect(useCase.execute()).resolves.toBeUndefined()
    expect(getVerificationStatus).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ruguin/core-server test -- sync-sender-identity-verification`
Expected: FAIL — `../sync-sender-identity-verification.use-case` does not exist yet.

- [ ] **Step 3: Write the use case**

Create `apps/core-server/src/modules/sender-identities/application/use-cases/sync-sender-identity-verification.use-case.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common'

import { SES_IDENTITY_PROVIDER, type SesIdentityProvider } from '../../domain/contracts/providers/ses-identity.provider'
import {
  SENDER_IDENTITY_REPOSITORY,
  type SenderIdentityRepository
} from '../../domain/contracts/repositories/sender-identity.repository'
import {
  SENDER_IDENTITY_CACHE_PROVIDER,
  type SenderIdentityCacheProvider
} from '../../domain/contracts/sender-identity-cache.provider'

@Injectable()
export class SyncSenderIdentityVerificationUseCase {
  private readonly logger = new Logger(SyncSenderIdentityVerificationUseCase.name)

  constructor(
    @Inject(SENDER_IDENTITY_REPOSITORY) private readonly repository: SenderIdentityRepository,
    @Inject(SES_IDENTITY_PROVIDER) private readonly sesIdentityProvider: SesIdentityProvider,
    @Inject(SENDER_IDENTITY_CACHE_PROVIDER) private readonly cache: SenderIdentityCacheProvider
  ) {}

  public async execute(): Promise<void> {
    const unverified = await this.repository.findUnverified()
    if (unverified.isFailure()) {
      this.logger.warn(`Failed to list unverified sender identities: ${unverified.value.message}`)
      return
    }

    for (const senderIdentity of unverified.value.senderIdentities) {
      await this.syncOne(senderIdentity.id.toString(), senderIdentity.email)
    }
  }

  private async syncOne(id: string, email: string): Promise<void> {
    const status = await this.sesIdentityProvider.getVerificationStatus({ email })
    if (status.isFailure()) {
      /*
       * One identity's SES call failing (rate limit, transient network) must not stop the sweep —
       * the rest of the unverified batch still deserves its check this tick, and this one gets
       * retried automatically on the next.
       */
      this.logger.warn(`Failed to check SES verification status for ${email}: ${status.value.message}`)
      return
    }

    if (!status.value.verified) return

    const marked = await this.repository.markVerified({ id, verifiedAt: new Date() })
    if (marked.isFailure()) {
      this.logger.warn(`Verified with SES but failed to persist for sender identity ${id}: ${marked.value.message}`)
      return
    }

    await this.cache.invalidate({ senderIdentityId: id })
    this.logger.log(`Sender identity ${id} (${email}) is now verified.`)
  }
}
```

- [ ] **Step 4: Run the use case test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- sync-sender-identity-verification`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing scheduled-job test**

Create `apps/core-server/src/modules/sender-identities/infrastructure/jobs/__tests__/sender-identity-sync.service.unit.ts`:

```ts
import { Logger } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import { type SyncSenderIdentityVerificationUseCase } from '../../../application/use-cases/sync-sender-identity-verification.use-case'
import { SenderIdentitySyncService } from '../sender-identity-sync.service'

describe('SenderIdentitySyncService#sync', () => {
  it('runs the use case', async () => {
    const execute = vi.fn().mockResolvedValue(undefined)
    const useCase = { execute } as unknown as SyncSenderIdentityVerificationUseCase
    const service = new SenderIdentitySyncService(useCase)

    await service.sync()

    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('skips a tick entirely while the previous one is still running', async () => {
    let resolveFirst: () => void = () => {}
    const firstRun = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const execute = vi.fn().mockReturnValueOnce(firstRun).mockResolvedValue(undefined)
    const useCase = { execute } as unknown as SyncSenderIdentityVerificationUseCase
    const service = new SenderIdentitySyncService(useCase)

    const first = service.sync()
    const second = service.sync()
    resolveFirst()
    await Promise.all([first, second])

    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('swallows a thrown error instead of letting it escape the interval timer', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const execute = vi.fn().mockRejectedValue(new Error('unexpected'))
    const useCase = { execute } as unknown as SyncSenderIdentityVerificationUseCase
    const service = new SenderIdentitySyncService(useCase)

    await expect(service.sync()).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm --filter @ruguin/core-server test -- sender-identity-sync.service`
Expected: FAIL — `../sender-identity-sync.service` does not exist yet.

- [ ] **Step 7: Write the scheduled job**

Create `apps/core-server/src/modules/sender-identities/infrastructure/jobs/sender-identity-sync.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'

import { SyncSenderIdentityVerificationUseCase } from '../../application/use-cases/sync-sender-identity-verification.use-case'

// Env-configurable intervals can't be read from an @Interval decorator argument — see this plan's
// Global Constraints. Matches OutboxRelayService's own RELAY_INTERVAL_MS precedent.
const SYNC_INTERVAL_MS = 60_000

@Injectable()
export class SenderIdentitySyncService {
  private readonly logger = new Logger(SenderIdentitySyncService.name)
  private isRunning = false

  constructor(private readonly syncUseCase: SyncSenderIdentityVerificationUseCase) {}

  @Interval(SYNC_INTERVAL_MS)
  public async sync(): Promise<void> {
    /*
     * Same overlap guard as OutboxRelayService: @Interval has none built in, and a slow tick (many
     * unverified rows, a slow SES response) must not stack a second sweep on top of the first.
     */
    if (this.isRunning) return

    this.isRunning = true
    try {
      await this.syncUseCase.execute()
    } catch (error: unknown) {
      /*
       * The use case itself never throws (every branch logs and returns) — this is a last-resort
       * net so a bug there can never crash the interval timer and silently stop all future syncs.
       */
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`Sender identity sync tick failed: ${message}`)
    } finally {
      this.isRunning = false
    }
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- sender-identity-sync.service`
Expected: PASS (3 tests).

- [ ] **Step 9: Wire the use case and job into the module**

`@nestjs/schedule`'s `ScheduleModule.forRoot()` must be registered somewhere in the app for
`@Interval` to actually fire — check `app.module.ts` for an existing `ScheduleModule.forRoot()`
import before adding a second one; `OutboxRelayService`'s own `@Interval` already requires it, so if
core-server's outbox relay works today, it is already registered (likely inside `OutboxModule`) and
nothing further is needed here.

In `apps/core-server/src/modules/sender-identities/sender-identities.module.ts`, add the use case
and job:

```ts
import { Module } from '@nestjs/common'

import { RegisterSenderIdentityUseCase } from './application/use-cases/register-sender-identity.use-case'
import { ListSenderIdentitiesUseCase } from './application/use-cases/list-sender-identities.use-case'
import { SyncSenderIdentityVerificationUseCase } from './application/use-cases/sync-sender-identity-verification.use-case'
import { SES_IDENTITY_PROVIDER } from './domain/contracts/providers/ses-identity.provider'
import { SENDER_IDENTITY_REPOSITORY } from './domain/contracts/repositories/sender-identity.repository'
import { SENDER_IDENTITY_CACHE_PROVIDER } from './domain/contracts/sender-identity-cache.provider'
import { AwsSesIdentityProvider } from './infrastructure/aws/ses-identity.provider'
import { sesV2ClientProvider } from './infrastructure/aws/ses-v2-client.provider'
import { SenderIdentityCacheProvider } from './infrastructure/cache/sender-identity-cache.provider'
import { SenderIdentityRepository } from './infrastructure/database/prisma/sender-identity.repository'
import { SenderIdentitySyncService } from './infrastructure/jobs/sender-identity-sync.service'

@Module({
  providers: [
    SenderIdentityRepository,
    { provide: SENDER_IDENTITY_REPOSITORY, useExisting: SenderIdentityRepository },
    sesV2ClientProvider,
    AwsSesIdentityProvider,
    { provide: SES_IDENTITY_PROVIDER, useExisting: AwsSesIdentityProvider },
    SenderIdentityCacheProvider,
    { provide: SENDER_IDENTITY_CACHE_PROVIDER, useExisting: SenderIdentityCacheProvider },
    RegisterSenderIdentityUseCase,
    ListSenderIdentitiesUseCase,
    SyncSenderIdentityVerificationUseCase,
    SenderIdentitySyncService
  ],
  exports: [SENDER_IDENTITY_REPOSITORY, SES_IDENTITY_PROVIDER, SENDER_IDENTITY_CACHE_PROVIDER]
})
export class SenderIdentitiesModule {}
```

- [ ] **Step 10: Run the full core-server test suite and type check**

Run: `pnpm --filter @ruguin/core-server test && pnpm --filter @ruguin/core-server check:types`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/core-server
git commit -m "feat(core-server): sender identity SES verification sync job"
```

---

### Task 8: Presentation — controller, DTO, service, router registration

**Files:**

- Create: `apps/core-server/src/modules/sender-identities/domain/errors/invalid-register-sender-identity-request.error.ts`
- Create: `apps/core-server/src/modules/sender-identities/presentation/dtos/register-sender-identity.dto.ts`
- Test: `apps/core-server/src/modules/sender-identities/presentation/dtos/__tests__/register-sender-identity.dto.unit.ts`
- Create: `apps/core-server/src/modules/sender-identities/application/services/sender-identity.service.ts`
- Create: `apps/core-server/src/modules/sender-identities/presentation/controllers/sender-identity.controller.ts`
- Test: `apps/core-server/src/modules/sender-identities/presentation/controllers/__tests__/sender-identity.controller.unit.ts`
- Create: `apps/core-server/src/modules/sender-identities/presentation/routes/routes.user.module.ts`
- Modify: `apps/core-server/src/modules/sender-identities/sender-identities.module.ts`
- Modify: `apps/core-server/src/router/router.module.ts`

**Interfaces:**

- Consumes: `RegisterSenderIdentityUseCase`, `ListSenderIdentitiesUseCase` (Task 6), `ApiKeyAuthGuard`
  / `AuthenticatedTenantParameter` (existing, `api-keys` module).
- Produces: `POST /sender-identities`, `GET /sender-identities` — both behind `ApiKeyAuthGuard`.

- [ ] **Step 1: Write the request-validation error**

Create `apps/core-server/src/modules/sender-identities/domain/errors/invalid-register-sender-identity-request.error.ts`:

```ts
import { BaseError, StatusError } from '@ruguin/shared-domain'
import { type z } from 'zod'

export class InvalidRegisterSenderIdentityRequestError extends BaseError {
  readonly name = 'InvalidRegisterSenderIdentityRequestError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { issues: readonly z.core.$ZodIssue[] }) {
    super({ error: input.issues, message: 'Request body must include { name, email }.' })
  }
}
```

- [ ] **Step 2: Write the failing DTO test**

Create `apps/core-server/src/modules/sender-identities/presentation/dtos/__tests__/register-sender-identity.dto.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { RegisterSenderIdentityBodySchema } from '../register-sender-identity.dto'

describe('RegisterSenderIdentityBodySchema', () => {
  it('accepts a valid { name, email } body', () => {
    const result = RegisterSenderIdentityBodySchema.safeParse({ name: 'Will Gravina', email: 'will@gravina.dev' })

    expect(result.success).toBe(true)
  })

  it('rejects an empty name', () => {
    const result = RegisterSenderIdentityBodySchema.safeParse({ name: '', email: 'will@gravina.dev' })

    expect(result.success).toBe(false)
  })

  it('rejects an invalid email', () => {
    const result = RegisterSenderIdentityBodySchema.safeParse({ name: 'Will Gravina', email: 'not-an-email' })

    expect(result.success).toBe(false)
  })

  it('rejects an unknown extra field', () => {
    const result = RegisterSenderIdentityBodySchema.safeParse({
      name: 'Will Gravina',
      email: 'will@gravina.dev',
      isDefault: true
    })

    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @ruguin/core-server test -- register-sender-identity.dto`
Expected: FAIL — `../register-sender-identity.dto` does not exist yet.

- [ ] **Step 4: Write the DTO**

Create `apps/core-server/src/modules/sender-identities/presentation/dtos/register-sender-identity.dto.ts`:

```ts
import { z } from 'zod'

export const RegisterSenderIdentityBodySchema = z
  .object({
    name: z.string().min(1),
    email: z.email()
  })
  .strict()

export type RegisterSenderIdentityBody = z.infer<typeof RegisterSenderIdentityBodySchema>
```

- [ ] **Step 5: Run the DTO test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- register-sender-identity.dto`
Expected: PASS (4 tests).

- [ ] **Step 6: Write the service**

Create `apps/core-server/src/modules/sender-identities/application/services/sender-identity.service.ts`:

```ts
import { Injectable } from '@nestjs/common'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

import { type SenderIdentity } from '../../domain/models/sender-identity.model'
import { ListSenderIdentitiesUseCase } from '../use-cases/list-sender-identities.use-case'
import {
  RegisterSenderIdentityUseCase,
  type RegisterSenderIdentityUseCaseInput
} from '../use-cases/register-sender-identity.use-case'

/*
 * Forwards only — no branching, no repository access. Same deliberate shape as
 * emails/application/services/send-email.service.ts: keeps the controller's signature uniform and
 * is where a future cross-cutting concern attaches without touching the use cases.
 */
@Injectable()
export class SenderIdentityService {
  constructor(
    private readonly registerUseCase: RegisterSenderIdentityUseCase,
    private readonly listUseCase: ListSenderIdentitiesUseCase
  ) {}

  public register(input: RegisterSenderIdentityUseCaseInput): Promise<Either<BaseError, SenderIdentity>> {
    return this.registerUseCase.execute(input)
  }

  public list(input: { projectId: string }): Promise<Either<BaseError, SenderIdentity[]>> {
    return this.listUseCase.execute(input)
  }
}
```

- [ ] **Step 7: Write the failing controller test**

Create `apps/core-server/src/modules/sender-identities/presentation/controllers/__tests__/sender-identity.controller.unit.ts`:

```ts
import { ID } from '@ruguin/shared-domain'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type AuthenticatedTenant } from '../../../../api-keys/infrastructure/http/authenticated-tenant'
import { type SenderIdentityService } from '../../../application/services/sender-identity.service'
import { InvalidRegisterSenderIdentityRequestError } from '../../../domain/errors/invalid-register-sender-identity-request.error'
import { InvalidSenderIdentityError } from '../../../domain/errors/invalid-sender-identity.error'
import { SenderIdentity } from '../../../domain/models/sender-identity.model'
import { SenderIdentityController } from '../sender-identity.controller'

function validId(): ID {
  const generated = ID.generate({ modelName: 'SenderIdentity' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildSenderIdentity() {
  const result = SenderIdentity.create({
    id: validId(),
    projectId: 'project-1',
    name: 'Will Gravina',
    email: 'will@gravina.dev',
    verifiedAt: null,
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

const tenant: AuthenticatedTenant = { projectId: 'project-1', organizationId: 'org-1' }

describe('SenderIdentityController#register', () => {
  it('returns the created resource, resolved domain included, on success', async () => {
    const senderIdentity = buildSenderIdentity()
    const service = {
      register: vi.fn().mockResolvedValue(success(senderIdentity))
    } as unknown as SenderIdentityService
    const controller = new SenderIdentityController(service)

    const response = await controller.register({ name: 'Will Gravina', email: 'will@gravina.dev' }, tenant)

    expect(response).toMatchObject({
      name: 'Will Gravina',
      email: 'will@gravina.dev',
      domain: 'gravina.dev',
      verifiedAt: null
    })
    expect(service.register).toHaveBeenCalledWith({
      name: 'Will Gravina',
      email: 'will@gravina.dev',
      projectId: 'project-1'
    })
  })

  it('throws InvalidRegisterSenderIdentityRequestError for a malformed body, without calling the service', async () => {
    const service = { register: vi.fn() } as unknown as SenderIdentityService
    const controller = new SenderIdentityController(service)

    await expect(controller.register({ name: '' }, tenant)).rejects.toBeInstanceOf(
      InvalidRegisterSenderIdentityRequestError
    )
    expect(service.register).not.toHaveBeenCalled()
  })

  it('throws whatever BaseError the service returns as a failure', async () => {
    const service = {
      register: vi.fn().mockResolvedValue(failure(new InvalidSenderIdentityError({ reason: 'name is empty' })))
    } as unknown as SenderIdentityService
    const controller = new SenderIdentityController(service)

    await expect(
      controller.register({ name: 'Will Gravina', email: 'will@gravina.dev' }, tenant)
    ).rejects.toBeInstanceOf(InvalidSenderIdentityError)
  })
})

describe('SenderIdentityController#list', () => {
  it('returns every sender identity for the authenticated project', async () => {
    const senderIdentity = buildSenderIdentity()
    const service = {
      list: vi.fn().mockResolvedValue(success([senderIdentity]))
    } as unknown as SenderIdentityService
    const controller = new SenderIdentityController(service)

    const response = await controller.list(tenant)

    expect(response).toHaveLength(1)
    expect(service.list).toHaveBeenCalledWith({ projectId: 'project-1' })
  })

  it('throws whatever BaseError the service returns as a failure', async () => {
    const service = {
      list: vi.fn().mockResolvedValue(failure(new InvalidSenderIdentityError({ reason: 'boom' })))
    } as unknown as SenderIdentityService
    const controller = new SenderIdentityController(service)

    await expect(controller.list(tenant)).rejects.toBeInstanceOf(InvalidSenderIdentityError)
  })
})
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `pnpm --filter @ruguin/core-server test -- sender-identity.controller`
Expected: FAIL — `../sender-identity.controller` does not exist yet.

- [ ] **Step 9: Write the controller**

Create `apps/core-server/src/modules/sender-identities/presentation/controllers/sender-identity.controller.ts`:

```ts
import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common'

import { ApiKeyAuthGuard } from '../../../api-keys/infrastructure/http/api-key-auth.guard'
import { type AuthenticatedTenant } from '../../../api-keys/infrastructure/http/authenticated-tenant'
import { AuthenticatedTenantParameter } from '../../../api-keys/infrastructure/http/authenticated-tenant.decorator'
import { SenderIdentityService } from '../../application/services/sender-identity.service'
import { InvalidRegisterSenderIdentityRequestError } from '../../domain/errors/invalid-register-sender-identity-request.error'
import { type SenderIdentity } from '../../domain/models/sender-identity.model'
import { RegisterSenderIdentityBodySchema } from '../dtos/register-sender-identity.dto'

type SenderIdentityResponse = { id: string; name: string; email: string; domain: string; verifiedAt: string | null }

function toResponse(senderIdentity: SenderIdentity): SenderIdentityResponse {
  return {
    id: senderIdentity.id.toString(),
    name: senderIdentity.name,
    email: senderIdentity.email,
    domain: senderIdentity.domain,
    verifiedAt: senderIdentity.verifiedAt?.toISOString() ?? null
  }
}

@Controller()
@UseGuards(ApiKeyAuthGuard)
export class SenderIdentityController {
  constructor(private readonly senderIdentityService: SenderIdentityService) {}

  @Post()
  @HttpCode(201)
  public async register(
    @Body() rawBody: unknown,
    @AuthenticatedTenantParameter() tenant: AuthenticatedTenant
  ): Promise<SenderIdentityResponse> {
    const parsed = RegisterSenderIdentityBodySchema.safeParse(rawBody)
    if (!parsed.success) throw new InvalidRegisterSenderIdentityRequestError({ issues: parsed.error.issues })

    const result = await this.senderIdentityService.register({ ...parsed.data, projectId: tenant.projectId })
    if (result.isFailure()) throw result.value

    return toResponse(result.value)
  }

  @Get()
  public async list(@AuthenticatedTenantParameter() tenant: AuthenticatedTenant): Promise<SenderIdentityResponse[]> {
    const result = await this.senderIdentityService.list({ projectId: tenant.projectId })
    if (result.isFailure()) throw result.value

    return result.value.map(toResponse)
  }
}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- sender-identity.controller`
Expected: PASS (5 tests).

- [ ] **Step 11: Wire the controller and service into the module**

Replace the full contents of `apps/core-server/src/modules/sender-identities/sender-identities.module.ts`:

```ts
import { Module } from '@nestjs/common'

import { ApiKeysModule } from '../api-keys/api-keys.module'

import { SenderIdentityService } from './application/services/sender-identity.service'
import { ListSenderIdentitiesUseCase } from './application/use-cases/list-sender-identities.use-case'
import { RegisterSenderIdentityUseCase } from './application/use-cases/register-sender-identity.use-case'
import { SyncSenderIdentityVerificationUseCase } from './application/use-cases/sync-sender-identity-verification.use-case'
import { SES_IDENTITY_PROVIDER } from './domain/contracts/providers/ses-identity.provider'
import { SENDER_IDENTITY_REPOSITORY } from './domain/contracts/repositories/sender-identity.repository'
import { SENDER_IDENTITY_CACHE_PROVIDER } from './domain/contracts/sender-identity-cache.provider'
import { AwsSesIdentityProvider } from './infrastructure/aws/ses-identity.provider'
import { sesV2ClientProvider } from './infrastructure/aws/ses-v2-client.provider'
import { SenderIdentityCacheProvider } from './infrastructure/cache/sender-identity-cache.provider'
import { SenderIdentityRepository } from './infrastructure/database/prisma/sender-identity.repository'
import { SenderIdentitySyncService } from './infrastructure/jobs/sender-identity-sync.service'
import { SenderIdentityController } from './presentation/controllers/sender-identity.controller'

@Module({
  imports: [ApiKeysModule],
  controllers: [SenderIdentityController],
  providers: [
    SenderIdentityRepository,
    { provide: SENDER_IDENTITY_REPOSITORY, useExisting: SenderIdentityRepository },
    sesV2ClientProvider,
    AwsSesIdentityProvider,
    { provide: SES_IDENTITY_PROVIDER, useExisting: AwsSesIdentityProvider },
    SenderIdentityCacheProvider,
    { provide: SENDER_IDENTITY_CACHE_PROVIDER, useExisting: SenderIdentityCacheProvider },
    RegisterSenderIdentityUseCase,
    ListSenderIdentitiesUseCase,
    SyncSenderIdentityVerificationUseCase,
    SenderIdentitySyncService,
    SenderIdentityService
  ],
  exports: [SENDER_IDENTITY_REPOSITORY, SES_IDENTITY_PROVIDER, SENDER_IDENTITY_CACHE_PROVIDER]
})
export class SenderIdentitiesModule {}
```

`ApiKeysModule` is imported (not just `ApiKeyAuthGuard` imported directly into the controller file)
because NestJS resolves a guard's own dependencies against the module that declares the controller
using it — `ApiKeyAuthGuard` needs `API_KEY_REPOSITORY`/`PROJECT_LOOKUP_PROVIDER` visible, which only
`ApiKeysModule`'s own imports provide. Same reasoning as `EmailsModule` importing `ApiKeysModule`.

- [ ] **Step 12: Create the routes wrapper module and register it**

Create `apps/core-server/src/modules/sender-identities/presentation/routes/routes.user.module.ts`:

```ts
import { Module } from '@nestjs/common'

import { SenderIdentitiesModule } from '../../sender-identities.module'

@Module({
  controllers: [],
  providers: [],
  exports: [],
  imports: [SenderIdentitiesModule]
})
export class RoutesSenderIdentitiesModule {}
```

Replace the full contents of `apps/core-server/src/router/router.module.ts`:

```ts
import { Module } from '@nestjs/common'
import { RouterModule as NestJsRouterModule } from '@nestjs/core'

import { EmailsModule } from '../modules/emails/emails.module'
import { RoutesEmailsModule } from '../modules/emails/presentation/routes/routes.user.module'
import { HealthModule } from '../modules/health/health.module'
import { RoutesSenderIdentitiesModule } from '../modules/sender-identities/presentation/routes/routes.user.module'
import { SenderIdentitiesModule } from '../modules/sender-identities/sender-identities.module'

@Module({
  providers: [],
  exports: [],
  controllers: [],
  imports: [
    HealthModule,
    RoutesEmailsModule,
    RoutesSenderIdentitiesModule,
    /*
     * HealthController already declares its own full path (`@Controller({ path: 'health' })`), so
     * registering it here too would double-prefix it to /health/health — only modules without an
     * explicit controller path belong in this list.
     *
     * RouterModule.register() builds its own route tree, separate from ordinary Nest module
     * imports/DI. A `path` prefix only reaches the controllers declared directly on the target
     * module, and only propagates further through this tree's own `children` entries — NOT by
     * following the target module's `@Module({ imports: [...] })` metadata. Each Routes* wrapper
     * merely imports its real module for DI composition, so the real controller (declared inside
     * that module, not the wrapper) needs its own `children` entry here to inherit the prefix.
     */
    NestJsRouterModule.register([
      {
        path: '/emails',
        module: RoutesEmailsModule,
        children: [{ path: '', module: EmailsModule }]
      },
      {
        path: '/sender-identities',
        module: RoutesSenderIdentitiesModule,
        children: [{ path: '', module: SenderIdentitiesModule }]
      }
    ])
  ]
})
export class RouterModule {}
```

- [ ] **Step 13: Run the full core-server test suite, type check, and lint**

Run: `pnpm --filter @ruguin/core-server test && pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/core-server check:lint`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add apps/core-server
git commit -m "feat(core-server): POST and GET /sender-identities"
```

---

### Task 9: `Template.senderIdentityId` + seed

**Files:**

- Modify: `apps/core-server/prisma/schema/template.prisma`
- Create: `apps/core-server/prisma/migrations/20260805080000_add_template_sender_identity/migration.sql`
- Modify: `apps/core-server/src/modules/templates/domain/models/template.model.ts`
- Test: `apps/core-server/src/modules/templates/domain/models/__tests__/template.model.unit.ts` (modify)
- Modify: `apps/core-server/src/modules/templates/infrastructure/database/prisma/template.repository.ts`
- Test: `apps/core-server/src/modules/templates/infrastructure/database/prisma/__tests__/template.repository.unit.ts` (modify)
- Modify: `apps/core-server/prisma/seed.ts`

**Interfaces:**

- Produces: `Template.create(input: {..., senderIdentityId: string, ...})` — the constructor
  parameter order becomes `(id, projectId, senderIdentityId, name, subject, html, createdAt)`,
  consumed by Task 11's `SendEmailUseCase` (reads `template.senderIdentityId` to resolve the
  sender).

- [ ] **Step 1: Reset the local dev database before this migration**

Both this task and Task 10 add a `NOT NULL` column with no default to a table that almost certainly
already has rows from earlier `seed`/e2e runs in this session — `ALTER TABLE ... ADD COLUMN ... NOT
NULL` fails against a non-empty table with no default. This is expected, not a bug to work around:
the project is pre-production (design spec, "Fora de escopo") and has no real data to preserve.

Run: `docker compose -f infrastructure/local/docker-compose.yml down -v postgres && docker compose -f infrastructure/local/docker-compose.yml up -d postgres`
(or, if LocalStack's free-tier auth token isn't configured in this environment, scope to the
Postgres service the same way this session's earlier work did: `LOCALSTACK_AUTH_TOKEN=dummy docker
compose -f infrastructure/local/docker-compose.yml up -d postgres`)

- [ ] **Step 2: Add the column to the Prisma schema**

In `apps/core-server/prisma/schema/template.prisma`, add `senderIdentityId` and its index:

```prisma
model Template {
  id               String   @id @default(uuid(7))
  projectId        String
  senderIdentityId String
  name             String
  subject          String
  html             String
  createdAt        DateTime @default(now())

  @@index([projectId])
  @@index([senderIdentityId])
  @@map("templates")
}
```

- [ ] **Step 3: Write the migration by hand**

Create the directory `apps/core-server/prisma/migrations/20260805080000_add_template_sender_identity/`
and inside it `migration.sql`:

```sql
-- AlterTable
ALTER TABLE "templates" ADD COLUMN "senderIdentityId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "templates_senderIdentityId_idx" ON "templates"("senderIdentityId");
```

Apply it: `pnpm with-env pnpm --filter @ruguin/core-server db:deploy`
Then regenerate the client: `pnpm --filter @ruguin/core-server db:generate`

- [ ] **Step 4: Update the failing model test**

Replace the full contents of `apps/core-server/src/modules/templates/domain/models/__tests__/template.model.unit.ts`:

```ts
import { ID } from '@ruguin/shared-domain'
import { describe, expect, it } from 'vitest'

import { Template } from '../template.model'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Template' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('Template.create', () => {
  it('builds a Template from valid input', () => {
    const result = Template.create({
      id: validId(),
      projectId: 'project-1',
      senderIdentityId: 'sender-1',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '<p>Hi {{name}}</p>',
      createdAt: new Date('2026-08-05T00:00:00Z')
    })

    expect(result.isSuccess()).toBe(true)
  })

  it('rejects an empty senderIdentityId', () => {
    const result = Template.create({
      id: validId(),
      projectId: 'project-1',
      senderIdentityId: '',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '<p>Hi {{name}}</p>',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty subject', () => {
    const result = Template.create({
      id: validId(),
      projectId: 'project-1',
      senderIdentityId: 'sender-1',
      name: 'Welcome',
      subject: '',
      html: '<p>Hi {{name}}</p>',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty html', () => {
    const result = Template.create({
      id: validId(),
      projectId: 'project-1',
      senderIdentityId: 'sender-1',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })
})
```

Run: `pnpm --filter @ruguin/core-server test -- template.model.unit`
Expected: FAIL — `Template.create` doesn't accept/require `senderIdentityId` yet.

- [ ] **Step 5: Update the model**

Replace the full contents of `apps/core-server/src/modules/templates/domain/models/template.model.ts`:

```ts
import { type ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidTemplateError } from '../errors/invalid-template.error'

export class Template {
  private constructor(
    readonly id: ID,
    readonly projectId: string,
    readonly senderIdentityId: string,
    readonly name: string,
    readonly subject: string,
    readonly html: string,
    readonly createdAt: Date
  ) {
    Object.freeze(this)
  }

  public static create(input: {
    id: ID
    projectId: string
    senderIdentityId: string
    name: string
    subject: string
    html: string
    createdAt: Date
  }): Either<InvalidTemplateError, Template> {
    if (input.senderIdentityId.trim().length === 0) {
      return failure(new InvalidTemplateError({ reason: 'senderIdentityId is empty' }))
    }
    if (input.subject.trim().length === 0) return failure(new InvalidTemplateError({ reason: 'subject is empty' }))
    if (input.html.trim().length === 0) return failure(new InvalidTemplateError({ reason: 'html is empty' }))

    return success(
      new Template(
        input.id,
        input.projectId,
        input.senderIdentityId,
        input.name,
        input.subject,
        input.html,
        input.createdAt
      )
    )
  }
}
```

- [ ] **Step 6: Run the model test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- template.model.unit`
Expected: PASS.

- [ ] **Step 7: Update the repository and its test**

Replace the full contents of `apps/core-server/src/modules/templates/infrastructure/database/prisma/template.repository.ts`:

```ts
import { Injectable } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { PrismaService } from '../../../../../shared/infrastructure/database/prisma/prisma.service'
import { type TemplateLookupProvider } from '../../../domain/contracts/template-lookup.provider'
import { FindTemplateError } from '../../../domain/errors/find-template.error'
import { InvalidTemplateError } from '../../../domain/errors/invalid-template.error'
import { Template } from '../../../domain/models/template.model'

@Injectable()
export class TemplateRepository implements TemplateLookupProvider {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(row: {
    id: string
    projectId: string
    senderIdentityId: string
    name: string
    subject: string
    html: string
    createdAt: Date
  }): Either<InvalidTemplateError, Template> {
    const idResult = ID.validate({ id: row.id, modelName: 'Template' })
    if (idResult.isFailure()) return failure(new InvalidTemplateError({ reason: idResult.value.message }))

    return Template.create({
      id: idResult.value.idValidated,
      projectId: row.projectId,
      senderIdentityId: row.senderIdentityId,
      name: row.name,
      subject: row.subject,
      html: row.html,
      createdAt: row.createdAt
    })
  }

  public async findByIdAndProjectId(input: {
    templateId: string
    projectId: string
  }): Promise<Either<FindTemplateError, { template: Template | null }>> {
    try {
      /*
       * Scoped by BOTH columns in the query itself — never fetched by id alone and filtered after,
       * which would make the isolation check a runtime `if` instead of a query-shape guarantee.
       */
      const row = await this.prisma.template.findFirst({ where: { id: input.templateId, projectId: input.projectId } })
      if (row === null) return success({ template: null })

      const mapped = this.toDomain(row)
      if (mapped.isFailure()) return failure(new FindTemplateError({ error: mapped.value }))

      return success({ template: mapped.value })
    } catch (error: unknown) {
      return failure(new FindTemplateError({ error }))
    }
  }
}
```

Replace the full contents of `apps/core-server/src/modules/templates/infrastructure/database/prisma/__tests__/template.repository.unit.ts`:

```ts
import { ID } from '@ruguin/shared-domain'
import { describe, expect, it, vi } from 'vitest'

import { type PrismaService } from '../../../../../../shared/infrastructure/database/prisma/prisma.service'
import { TemplateRepository } from '../template.repository'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Template' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('TemplateRepository#findByIdAndProjectId', () => {
  it('maps a found row scoped to the project', async () => {
    const id = validId()
    const findFirst = vi.fn().mockResolvedValue({
      id: id.toString(),
      projectId: 'project-1',
      senderIdentityId: 'sender-1',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '<p>Hi {{name}}</p>',
      createdAt: new Date()
    })
    const prisma = { template: { findFirst } } as unknown as PrismaService
    const repository = new TemplateRepository(prisma)

    const result = await repository.findByIdAndProjectId({ templateId: id.toString(), projectId: 'project-1' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.template?.senderIdentityId).toBe('sender-1')
    expect(findFirst).toHaveBeenCalledWith({ where: { id: id.toString(), projectId: 'project-1' } })
  })

  it('returns { template: null } for a template owned by another project', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    const prisma = { template: { findFirst } } as unknown as PrismaService
    const repository = new TemplateRepository(prisma)

    const result = await repository.findByIdAndProjectId({ templateId: validId().toString(), projectId: 'project-1' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.template).toBeNull()
  })
})
```

Run: `pnpm --filter @ruguin/core-server test -- template.repository.unit`
Expected: PASS.

- [ ] **Step 8: Update the seed**

Replace the full contents of `apps/core-server/prisma/seed.ts`:

```ts
import { randomBytes } from 'node:crypto'

import { PrismaPg } from '@prisma/adapter-pg'

import { hashApiKey } from '../src/modules/api-keys/domain/hash-api-key'
import { PrismaClient } from '../src/shared/infrastructure/database/prisma/generated/client'

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL must be set to run the seed.')
  }

  /*
   * This app owns exactly one Postgres schema, core_server (see apps/core-server/CLAUDE.md) — a
   * DATABASE_URL missing ?schema= or pointing at a different one would silently seed into the
   * wrong place (Postgres defaults to `public`) rather than fail loudly.
   */
  const schema = new URL(connectionString).searchParams.get('schema')
  if (schema !== 'core_server') {
    throw new Error(`DATABASE_URL must include ?schema=core_server to run the seed (got: ${schema ?? 'none'}).`)
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) })

  const organization = await prisma.organization.create({ data: { name: 'Dev Organization' } })
  const project = await prisma.project.create({ data: { organizationId: organization.id, name: 'Dev Project' } })

  /*
   * Written directly, verifiedAt already set — bypasses the real SES CreateEmailIdentity call
   * (design spec decision 9) so dev/test never depends on AWS/LocalStack actually confirming a
   * mailbox that doesn't exist.
   */
  const senderIdentity = await prisma.senderIdentity.create({
    data: { projectId: project.id, name: 'Dev Sender', email: 'dev-sender@ruguin.dev', verifiedAt: new Date() }
  })

  const template = await prisma.template.create({
    data: {
      projectId: project.id,
      senderIdentityId: senderIdentity.id,
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '<p>Hi {{name}}</p>'
    }
  })

  /*
   * 32 bytes of entropy, hex-encoded — see design spec decision 9. Printed once; never
   * recoverable afterward, matching the guarantee that only its hash is ever persisted.
   */
  const rawApiKey = randomBytes(32).toString('hex')
  const hashedKey = hashApiKey({ rawKey: rawApiKey })
  await prisma.apiKey.create({ data: { projectId: project.id, hashedKey } })

  console.log('Seeded development data:')
  console.log(`  organizationId:   ${organization.id}`)
  console.log(`  projectId:        ${project.id}`)
  console.log(`  senderIdentityId: ${senderIdentity.id}`)
  console.log(`  templateId:       ${template.id}`)
  console.log(`  API key:          ${rawApiKey}`)
  console.log('This key is shown once. It is not recoverable — re-run the seed to mint a new one.')

  await prisma.$disconnect()
}

await main()
```

- [ ] **Step 9: Verify the seed runs cleanly against the reset database**

Run: `pnpm with-env pnpm --filter @ruguin/core-server exec tsx prisma/seed.ts`
Expected: prints all five values (`organizationId`, `projectId`, `senderIdentityId`, `templateId`,
`API key`) with no thrown error.

- [ ] **Step 10: Run the full core-server test suite and type check**

Run: `pnpm --filter @ruguin/core-server test && pnpm --filter @ruguin/core-server check:types`
Expected: unit and integration tests PASS. e2e tests are expected to still be RED after this task —
`email.controller.e2e.ts` and its own seed-driven setup are rewritten in Task 13; do not attempt to
fix e2e failures here.

- [ ] **Step 11: Commit**

```bash
git add apps/core-server
git commit -m "feat(core-server): Template.senderIdentityId, update seed"
```

---

### Task 10: `Email.senderIdentityId` + `templateId` required

**Files:**

- Modify: `apps/core-server/prisma/schema/email.prisma`
- Create: `apps/core-server/prisma/migrations/20260805090000_add_email_sender_identity/migration.sql`
- Modify: `apps/core-server/src/modules/emails/domain/models/email.model.ts`
- Test: `apps/core-server/src/modules/emails/domain/models/__tests__/email.model.unit.ts` (modify)
- Modify: `apps/core-server/src/modules/emails/infrastructure/database/prisma/email.repository.ts`
- Test: `apps/core-server/src/modules/emails/infrastructure/database/prisma/__tests__/email.repository.unit.ts` (modify)
- Test: `apps/core-server/src/modules/emails/infrastructure/database/prisma/__tests__/email.repository.int.ts` (modify)

**Interfaces:**

- Produces: `Email.create(input: {..., templateId: string, senderIdentityId: string, ...})` — the
  constructor parameter order becomes `(id, projectId, templateId, senderIdentityId,
  idempotencyKey, from, to, subject, html, createdAt)`, consumed by Task 11's `SendEmailUseCase`.

- [ ] **Step 1: Reset the local dev database (same reasoning as Task 9, Step 1)**

Run: `docker compose -f infrastructure/local/docker-compose.yml down -v postgres && docker compose -f infrastructure/local/docker-compose.yml up -d postgres`
(or with `LOCALSTACK_AUTH_TOKEN=dummy` prefixed, per Task 9)
Then re-apply every prior migration and re-run the seed:
`pnpm with-env pnpm --filter @ruguin/core-server db:deploy && pnpm with-env pnpm --filter @ruguin/core-server exec tsx prisma/seed.ts`

- [ ] **Step 2: Update the Prisma schema**

Replace the full contents of `apps/core-server/prisma/schema/email.prisma`:

```prisma
model Email {
  id               String      @id @default(uuid(7))
  projectId        String
  templateId       String
  senderIdentityId String
  idempotencyKey   String?
  from             String
  to               String
  subject          String
  html             String
  status           EmailStatus @default(QUEUED)
  createdAt        DateTime    @default(now())

  @@index([projectId])
  @@index([senderIdentityId])
  @@map("emails")
}

enum EmailStatus {
  QUEUED
}
```

- [ ] **Step 3: Write the migration by hand**

Create the directory `apps/core-server/prisma/migrations/20260805090000_add_email_sender_identity/`
and inside it `migration.sql`:

```sql
-- AlterTable
ALTER TABLE "emails" ADD COLUMN "senderIdentityId" TEXT NOT NULL,
ALTER COLUMN "templateId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "emails_senderIdentityId_idx" ON "emails"("senderIdentityId");
```

Apply it: `pnpm with-env pnpm --filter @ruguin/core-server db:deploy`
Then regenerate the client: `pnpm --filter @ruguin/core-server db:generate`

- [ ] **Step 4: Update the failing model test**

Replace the full contents of `apps/core-server/src/modules/emails/domain/models/__tests__/email.model.unit.ts`:

```ts
import { ID } from '@ruguin/shared-domain'
import { describe, expect, it } from 'vitest'

import { Email } from '../email.model'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Email' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('Email.create', () => {
  it('builds an Email from valid input', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      createdAt: new Date('2026-08-04T00:00:00Z')
    })

    expect(result.isSuccess()).toBe(true)
  })

  it('rejects an empty templateId', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: '',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty senderIdentityId', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: '',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty "from"', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: '',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty "to"', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: '',
      subject: 'Hello',
      html: '<p>Hello</p>',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty subject', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: '',
      html: '<p>Hello</p>',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })

  it('rejects an empty html', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })
})
```

Run: `pnpm --filter @ruguin/core-server test -- email.model.unit`
Expected: FAIL — `Email.create` doesn't require `senderIdentityId` or reject an empty `templateId`
yet.

- [ ] **Step 5: Update the model**

Replace the full contents of `apps/core-server/src/modules/emails/domain/models/email.model.ts`:

```ts
import { type ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidEmailError } from '../errors/models/invalid-email.error'

export class Email {
  private constructor(
    readonly id: ID,
    readonly projectId: string,
    readonly templateId: string,
    readonly senderIdentityId: string,
    readonly idempotencyKey: string | null,
    readonly from: string,
    readonly to: string,
    readonly subject: string,
    readonly html: string,
    readonly createdAt: Date
  ) {
    Object.freeze(this)
  }

  public static create(input: {
    id: ID
    projectId: string
    templateId: string
    senderIdentityId: string
    idempotencyKey: string | null
    from: string
    to: string
    subject: string
    html: string
    createdAt: Date
  }): Either<InvalidEmailError, Email> {
    if (input.projectId.trim().length === 0) return failure(new InvalidEmailError({ reason: 'projectId is empty' }))
    if (input.templateId.trim().length === 0) return failure(new InvalidEmailError({ reason: 'templateId is empty' }))
    if (input.senderIdentityId.trim().length === 0) {
      return failure(new InvalidEmailError({ reason: 'senderIdentityId is empty' }))
    }
    if (input.from.trim().length === 0) return failure(new InvalidEmailError({ reason: '"from" is empty' }))
    if (input.to.trim().length === 0) return failure(new InvalidEmailError({ reason: '"to" is empty' }))
    if (input.subject.trim().length === 0) return failure(new InvalidEmailError({ reason: 'subject is empty' }))
    if (input.html.trim().length === 0) return failure(new InvalidEmailError({ reason: 'html is empty' }))

    return success(
      new Email(
        input.id,
        input.projectId,
        input.templateId,
        input.senderIdentityId,
        input.idempotencyKey,
        input.from,
        input.to,
        input.subject,
        input.html,
        input.createdAt
      )
    )
  }
}
```

- [ ] **Step 6: Run the model test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- email.model.unit`
Expected: PASS.

- [ ] **Step 7: Update the Prisma repository**

Replace the full contents of `apps/core-server/src/modules/emails/infrastructure/database/prisma/email.repository.ts`:

```ts
import { Injectable } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { type TransactionContext } from '../../../../../shared/domain/contracts/transaction-context.contract'
import { type Prisma } from '../../../../../shared/infrastructure/database/prisma/generated/client'
import { type EmailRepository as EmailRepositoryContract } from '../../../domain/contracts/repositories/email.repository'
import { CreateEmailError } from '../../../domain/errors/models/create-email.error'
import { EmailIdempotencyConflictError } from '../../../domain/errors/models/email-idempotency-conflict.error'
import { InvalidEmailError } from '../../../domain/errors/models/invalid-email.error'
import { Email } from '../../../domain/models/email.model'

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

@Injectable()
export class EmailRepository implements EmailRepositoryContract {
  private toDomain(row: {
    id: string
    projectId: string
    templateId: string
    senderIdentityId: string
    idempotencyKey: string | null
    from: string
    to: string
    subject: string
    html: string
    createdAt: Date
  }): Either<InvalidEmailError, Email> {
    const idResult = ID.validate({ id: row.id, modelName: 'Email' })
    if (idResult.isFailure()) return failure(new InvalidEmailError({ reason: idResult.value.message }))

    return Email.create({
      id: idResult.value.idValidated,
      projectId: row.projectId,
      templateId: row.templateId,
      senderIdentityId: row.senderIdentityId,
      idempotencyKey: row.idempotencyKey,
      from: row.from,
      to: row.to,
      subject: row.subject,
      html: row.html,
      createdAt: row.createdAt
    })
  }

  private async recoverFromUniqueViolation(input: {
    client: Prisma.TransactionClient
    savepoint: string
    email: Email
    originalError: unknown
  }): Promise<Either<CreateEmailError | EmailIdempotencyConflictError, { email: Email; created: boolean }>> {
    const { client, savepoint, email, originalError } = input

    try {
      await client.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`)
    } catch (rollbackError: unknown) {
      return failure(new CreateEmailError({ error: rollbackError }))
    }

    const { idempotencyKey } = email
    if (idempotencyKey === null) return failure(new CreateEmailError({ error: originalError }))

    let existingRow: Awaited<ReturnType<typeof client.email.findFirst>>
    try {
      existingRow = await client.email.findFirst({ where: { projectId: email.projectId, idempotencyKey } })
    } catch (findError: unknown) {
      return failure(new CreateEmailError({ error: findError }))
    }
    if (existingRow === null) return failure(new CreateEmailError({ error: originalError }))

    const mapped = this.toDomain(existingRow)
    if (mapped.isFailure()) return failure(new CreateEmailError({ error: mapped.value }))

    const isSameRequest =
      mapped.value.from === email.from &&
      mapped.value.to === email.to &&
      mapped.value.subject === email.subject &&
      mapped.value.html === email.html
    if (!isSameRequest) return failure(new EmailIdempotencyConflictError({ idempotencyKey }))

    return success({ email: mapped.value, created: false })
  }

  public async createIfNotExists(input: {
    email: Email
    tx: TransactionContext
  }): Promise<Either<CreateEmailError | EmailIdempotencyConflictError, { email: Email; created: boolean }>> {
    const client = input.tx as unknown as Prisma.TransactionClient
    const savepoint = `create_email_${input.email.id.toString().replaceAll('-', '_')}`

    try {
      await client.$executeRawUnsafe(`SAVEPOINT ${savepoint}`)

      const row = await client.email.create({
        data: {
          id: input.email.id.toString(),
          projectId: input.email.projectId,
          templateId: input.email.templateId,
          senderIdentityId: input.email.senderIdentityId,
          idempotencyKey: input.email.idempotencyKey,
          from: input.email.from,
          to: input.email.to,
          subject: input.email.subject,
          html: input.email.html
        }
      })

      const mapped = this.toDomain(row)
      if (mapped.isFailure()) return failure(new CreateEmailError({ error: mapped.value }))

      return success({ email: mapped.value, created: true })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) return failure(new CreateEmailError({ error }))

      return this.recoverFromUniqueViolation({ client, savepoint, email: input.email, originalError: error })
    }
  }
}
```

The only functional change from the current file: `senderIdentityId` added to the `create` payload
and to `toDomain`'s row type. Everything else — the savepoint/rollback mechanics, the recovery
comparison — is unchanged.

- [ ] **Step 8: Update the repository unit test**

Replace the full contents of `apps/core-server/src/modules/emails/infrastructure/database/prisma/__tests__/email.repository.unit.ts`:

```ts
import { ID, StatusError } from '@ruguin/shared-domain'
import { describe, expect, it, vi } from 'vitest'

import { type TransactionContext } from '../../../../../../shared/domain/contracts/transaction-context.contract'
import { EmailIdempotencyConflictError } from '../../../../domain/errors/models/email-idempotency-conflict.error'
import { Email } from '../../../../domain/models/email.model'
import { EmailRepository } from '../email.repository'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Email' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildEmail(idempotencyKey: string | null, overrides: Partial<{ to: string; subject: string }> = {}) {
  const result = Email.create({
    id: validId(),
    projectId: 'project-1',
    templateId: 'template-1',
    senderIdentityId: 'sender-1',
    idempotencyKey,
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Hello',
    html: '<p>Hello</p>',
    createdAt: new Date('2026-08-04T00:00:00Z'),
    ...overrides
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

class UniqueConstraintViolation extends Error {
  readonly code = 'P2002'
  constructor() {
    super('Unique constraint failed')
    this.name = 'PrismaClientKnownRequestError'
  }
}

function createTxStub(input: {
  create: (data: Record<string, unknown>) => Promise<unknown>
  findFirst?: () => Promise<unknown>
  executeRawUnsafe?: (query: string) => Promise<unknown>
}): { tx: TransactionContext; findFirst: ReturnType<typeof vi.fn>; executeRawUnsafe: ReturnType<typeof vi.fn> } {
  const executeRawUnsafe = vi.fn(input.executeRawUnsafe ?? (() => Promise.resolve(0)))
  const findFirst = vi.fn(input.findFirst ?? (() => Promise.resolve(null)))
  const tx = {
    $executeRawUnsafe: executeRawUnsafe,
    email: {
      create: ({ data }: { data: Record<string, unknown> }) => input.create(data),
      findFirst
    }
  } as unknown as TransactionContext

  return { executeRawUnsafe, findFirst, tx }
}

describe('EmailRepository#createIfNotExists', () => {
  it('returns created: true and the persisted row on a fresh insert', async () => {
    const email = buildEmail('idem-1')
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: (data) =>
        Promise.resolve({
          id: data.id,
          projectId: data.projectId,
          templateId: data.templateId,
          senderIdentityId: data.senderIdentityId,
          idempotencyKey: data.idempotencyKey,
          from: data.from,
          to: data.to,
          subject: data.subject,
          html: data.html,
          createdAt: email.createdAt
        })
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.created).toBe(true)
      expect(result.value.email.id.toString()).toBe(email.id.toString())
    }
  })

  it('returns created: false and the pre-existing row when the partial unique index rejects the insert', async () => {
    const email = buildEmail('idem-1')
    const existingRow = {
      id: '0198f3b2-1234-7000-8000-000000000099',
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: 'idem-1',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      createdAt: new Date('2026-08-04T00:00:00Z')
    }
    const repository = new EmailRepository()
    const { findFirst, tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      },
      findFirst: () => Promise.resolve(existingRow)
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.created).toBe(false)
      expect(result.value.email.id.toString()).toBe(existingRow.id)
    }
    expect(findFirst).toHaveBeenCalledWith({ where: { projectId: 'project-1', idempotencyKey: 'idem-1' } })
  })

  it('returns EmailIdempotencyConflictError when the key was already used with a different body', async () => {
    const email = buildEmail('idem-1', { to: 'someone-else@example.com', subject: 'Different subject' })
    const existingRow = {
      id: '0198f3b2-1234-7000-8000-000000000099',
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: 'idem-1',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      createdAt: new Date('2026-08-04T00:00:00Z')
    }
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      },
      findFirst: () => Promise.resolve(existingRow)
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value).toBeInstanceOf(EmailIdempotencyConflictError)
      expect(result.value.status).toBe(StatusError.CONFLICT)
    }
  })

  it('treats a replay whose only difference is the rendered html as a conflict', async () => {
    const email = buildEmail('idem-1')
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      },
      findFirst: () =>
        Promise.resolve({
          id: '0198f3b2-1234-7000-8000-000000000099',
          projectId: 'project-1',
          templateId: '0198f3b2-1234-7000-8000-000000000020',
          senderIdentityId: 'sender-1',
          idempotencyKey: 'idem-1',
          from: 'sender@example.com',
          to: 'recipient@example.com',
          subject: 'Hello',
          html: '<p>Hello, Ada</p>',
          createdAt: new Date('2026-08-04T00:00:00Z')
        })
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(EmailIdempotencyConflictError)
  })

  it('maps any other thrown error into CreateEmailError', async () => {
    const email = buildEmail(null)
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: () => {
        throw new Error('connection terminated unexpectedly')
      }
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
  })

  it('returns failure without querying findFirst when a P2002 fires and the email has no idempotencyKey', async () => {
    const email = buildEmail(null)
    const repository = new EmailRepository()
    const { findFirst, tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      }
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('returns failure, not a thrown rejection, when the SAVEPOINT call itself fails', async () => {
    const email = buildEmail('idem-1')
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: () => Promise.resolve({}),
      executeRawUnsafe: () => Promise.reject(new Error('connection terminated unexpectedly'))
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
  })

  it('returns failure, not a thrown rejection, when the ROLLBACK TO SAVEPOINT call itself fails', async () => {
    const email = buildEmail('idem-1')
    const repository = new EmailRepository()
    let isSavepointTaken = false
    const { tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      },
      executeRawUnsafe: () => {
        if (!isSavepointTaken) {
          isSavepointTaken = true
          return Promise.resolve(0)
        }
        return Promise.reject(new Error('connection terminated unexpectedly'))
      }
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
  })
})
```

- [ ] **Step 9: Update the integration test**

Replace the full contents of `apps/core-server/src/modules/emails/infrastructure/database/prisma/__tests__/email.repository.int.ts`:

```ts
import { ID } from '@ruguin/shared-domain'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { type TransactionContext } from '../../../../../../shared/domain/contracts/transaction-context.contract'
import { type PrismaService } from '../../../../../../shared/infrastructure/database/prisma/prisma.service'
import { createTestPrismaService } from '../../../../../../shared/infrastructure/outbox/__tests__/outbox-test-context'
import { Email } from '../../../../domain/models/email.model'
import { EmailRepository } from '../email.repository'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Email' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

/*
 * templateId/senderIdentityId are plain string columns, not enforced Prisma @relation()s — see
 * apps/core-server/CLAUDE.md. A fixed literal that doesn't correspond to a real Template/
 * SenderIdentity row is fine here: this suite exercises only EmailRepository's own concurrency and
 * idempotency behavior, not any cross-table constraint.
 */
function buildEmail(input: { projectId: string; idempotencyKey: string | null }) {
  const result = Email.create({
    id: validId(),
    projectId: input.projectId,
    templateId: 'template-1',
    senderIdentityId: 'sender-1',
    idempotencyKey: input.idempotencyKey,
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Hello',
    html: '<p>Hello</p>',
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

describe('EmailRepository#createIfNotExists (integration)', () => {
  let prisma: PrismaService
  const repository = new EmailRepository()

  beforeAll(() => {
    prisma = createTestPrismaService()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await prisma.email.deleteMany()
  })

  it('lets two concurrent inserts with the same (projectId, idempotencyKey) resolve to one row and one winner', async () => {
    const projectId = `project-${validId().toString()}`
    const first = buildEmail({ projectId, idempotencyKey: 'concurrent-key' })
    const second = buildEmail({ projectId, idempotencyKey: 'concurrent-key' })

    const [firstResult, secondResult] = await Promise.all([
      prisma.$transaction((tx) =>
        repository.createIfNotExists({ email: first, tx: tx as unknown as TransactionContext })
      ),
      prisma.$transaction((tx) =>
        repository.createIfNotExists({ email: second, tx: tx as unknown as TransactionContext })
      )
    ])

    expect(firstResult.isSuccess()).toBe(true)
    expect(secondResult.isSuccess()).toBe(true)
    if (!firstResult.isSuccess() || !secondResult.isSuccess()) return

    const createdFlags = [firstResult.value.created, secondResult.value.created].toSorted(
      (a, b) => Number(a) - Number(b)
    )
    expect(createdFlags).toEqual([false, true])
    expect(firstResult.value.email.id.toString()).toBe(secondResult.value.email.id.toString())

    const rowCount = await prisma.email.count({ where: { projectId, idempotencyKey: 'concurrent-key' } })
    expect(rowCount).toBe(1)
  })

  it('allows two inserts with no idempotencyKey for the same project without colliding', async () => {
    const projectId = `project-${validId().toString()}`
    const first = buildEmail({ projectId, idempotencyKey: null })
    const second = buildEmail({ projectId, idempotencyKey: null })

    const firstResult = await prisma.$transaction((tx) =>
      repository.createIfNotExists({ email: first, tx: tx as unknown as TransactionContext })
    )
    const secondResult = await prisma.$transaction((tx) =>
      repository.createIfNotExists({ email: second, tx: tx as unknown as TransactionContext })
    )

    expect(firstResult.isSuccess() && firstResult.value.created).toBe(true)
    expect(secondResult.isSuccess() && secondResult.value.created).toBe(true)
  })
})
```

- [ ] **Step 10: Run the unit and integration tests**

Run: `pnpm --filter @ruguin/core-server test -- email.repository && pnpm --filter @ruguin/core-server test:integration -- email.repository.int`
Expected: PASS (8 unit + 2 integration).

- [ ] **Step 11: Run the full core-server type check**

Run: `pnpm --filter @ruguin/core-server check:types`
Expected: FAIL — `send-email.use-case.ts`, `email.controller.unit.ts`, and
`send-email.use-case.unit.ts` still call `Email.create`/build payloads against the old shape
(`templateId: null`, no `senderIdentityId`). This is expected; Task 11 fixes every remaining call
site.

- [ ] **Step 12: Commit**

```bash
git add apps/core-server
git commit -m "feat(core-server): Email.senderIdentityId, templateId required"
```

---

### Task 11: Send flow migration — minimalist `POST /v1/emails`, sender resolution, enforcement

**Files:**

- Create: `apps/core-server/src/modules/sender-identities/domain/errors/sender-identity-not-verified.error.ts`
- Modify: `apps/core-server/src/modules/emails/presentation/dtos/send-email.dto.ts`
- Test: `apps/core-server/src/modules/emails/presentation/dtos/__tests__/send-email.dto.unit.ts` (modify)
- Modify: `apps/core-server/src/modules/emails/application/use-cases/send-email.use-case.ts`
- Test: `apps/core-server/src/modules/emails/application/use-cases/__tests__/send-email.use-case.unit.ts` (modify)
- Test: `apps/core-server/src/modules/emails/presentation/controllers/__tests__/email.controller.unit.ts` (modify)
- Modify: `apps/core-server/src/modules/emails/emails.module.ts`

**Interfaces:**

- Consumes: `SENDER_IDENTITY_CACHE_PROVIDER` (Task 5), `Template.senderIdentityId` (Task 9),
  `Email.senderIdentityId` (Task 10).
- Produces: `SendEmailUseCaseInput = Readonly<{ projectId, organizationId, to, templateId,
  variables, idempotencyKey? }>` — the union type and `from` field are both gone. Consumed by Task
  13's rewritten e2e test.

- [ ] **Step 1: Write the new domain error**

Create `apps/core-server/src/modules/sender-identities/domain/errors/sender-identity-not-verified.error.ts`:

```ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class SenderIdentityNotVerifiedError extends BaseError {
  readonly name = 'SenderIdentityNotVerifiedError'
  readonly status = StatusError.UNPROCESSABLE

  constructor(input: { senderIdentityId: string }) {
    super({ message: `Sender identity ${input.senderIdentityId} is not verified yet.` })
  }
}
```

- [ ] **Step 2: Update the failing DTO test**

Replace the full contents of `apps/core-server/src/modules/emails/presentation/dtos/__tests__/send-email.dto.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { SendEmailBodySchema } from '../send-email.dto'

describe('SendEmailBodySchema', () => {
  it('accepts a valid { to, templateId, variables } body', () => {
    const result = SendEmailBodySchema.safeParse({
      to: 'recipient@example.com',
      templateId: '0198f3b2-1234-7000-8000-000000000020',
      variables: { name: 'Ada' }
    })

    expect(result.success).toBe(true)
  })

  it('defaults variables to {} when omitted', () => {
    const result = SendEmailBodySchema.safeParse({
      to: 'recipient@example.com',
      templateId: '0198f3b2-1234-7000-8000-000000000020'
    })

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.variables).toEqual({})
  })

  it('rejects a body missing templateId', () => {
    const result = SendEmailBodySchema.safeParse({ to: 'recipient@example.com' })

    expect(result.success).toBe(false)
  })

  it('rejects an invalid "to" address', () => {
    const result = SendEmailBodySchema.safeParse({
      to: 'not-an-email',
      templateId: '0198f3b2-1234-7000-8000-000000000020'
    })

    expect(result.success).toBe(false)
  })

  it('rejects a body carrying an unknown field like "from"', () => {
    const result = SendEmailBodySchema.safeParse({
      to: 'recipient@example.com',
      templateId: '0198f3b2-1234-7000-8000-000000000020',
      from: 'sender@example.com'
    })

    expect(result.success).toBe(false)
  })
})
```

Run: `pnpm --filter @ruguin/core-server test -- send-email.dto`
Expected: FAIL — the current schema still requires `from` and still accepts a `subject`+`html`
alternative.

- [ ] **Step 3: Update the DTO**

Replace the full contents of `apps/core-server/src/modules/emails/presentation/dtos/send-email.dto.ts`:

```ts
import { z } from 'zod'

export const SendEmailBodySchema = z
  .object({
    to: z.email(),
    templateId: z.uuid(),
    variables: z.record(z.string(), z.string()).default({})
  })
  .strict()

export type SendEmailBody = z.infer<typeof SendEmailBodySchema>
```

- [ ] **Step 4: Run the DTO test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- send-email.dto`
Expected: PASS (5 tests).

- [ ] **Step 5: Update the failing use case test**

Replace the full contents of `apps/core-server/src/modules/emails/application/use-cases/__tests__/send-email.use-case.unit.ts`:

```ts
import { ID } from '@ruguin/shared-domain'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type OutboxPort } from '../../../../../shared/domain/contracts/outbox.port'
import { type TransactionContext } from '../../../../../shared/domain/contracts/transaction-context.contract'
import { type TransactionManager } from '../../../../../shared/domain/contracts/transaction-manager.contract'
import { EnqueueOutboxMessageError } from '../../../../../shared/domain/errors/enqueue-outbox-message.error'
import { type SenderIdentityCacheProvider } from '../../../../sender-identities/domain/contracts/sender-identity-cache.provider'
import { SenderIdentityNotVerifiedError } from '../../../../sender-identities/domain/errors/sender-identity-not-verified.error'
import { SenderIdentity } from '../../../../sender-identities/domain/models/sender-identity.model'
import { type TemplateLookupProvider } from '../../../../templates/domain/contracts/template-lookup.provider'
import { TemplateNotFoundError } from '../../../../templates/domain/errors/template-not-found.error'
import { Template } from '../../../../templates/domain/models/template.model'
import { type EmailRepository } from '../../../domain/contracts/repositories/email.repository'
import { CreateEmailError } from '../../../domain/errors/models/create-email.error'
import { InvalidEmailPayloadError } from '../../../domain/errors/models/invalid-email-payload.error'
import { Email } from '../../../domain/models/email.model'
import { SendEmailUseCase } from '../send-email.use-case'

function validId(modelName: string): ID {
  const generated = ID.generate({ modelName })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildSenderIdentity(overrides: Partial<{ verifiedAt: Date | null }> = {}) {
  const result = SenderIdentity.create({
    id: validId('SenderIdentity'),
    projectId: '01900000-0000-7000-8000-000000000001',
    name: 'Sender',
    email: 'sender@example.com',
    verifiedAt: overrides.verifiedAt === undefined ? new Date() : overrides.verifiedAt,
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

function buildTemplate(senderIdentityId: string) {
  const result = Template.create({
    id: validId('Template'),
    projectId: '01900000-0000-7000-8000-000000000001',
    senderIdentityId,
    name: 'Welcome',
    subject: 'Hi {{name}}',
    html: '<p>Hi {{name}}</p>',
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

function buildEmail(overrides: Partial<{ idempotencyKey: string | null }> = {}) {
  const result = Email.create({
    id: validId('Email'),
    projectId: '01900000-0000-7000-8000-000000000001',
    templateId: '01900000-0000-7000-8000-000000000010',
    senderIdentityId: '01900000-0000-7000-8000-000000000011',
    idempotencyKey: overrides.idempotencyKey ?? null,
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Hi Ada',
    html: '<p>Hi Ada</p>',
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

function createTransactionManagerStub(): TransactionManager {
  return {
    execute: async (work) => work({} as TransactionContext)
  }
}

describe('SendEmailUseCase', () => {
  it('renders the template, persists the email, and enqueues email.send.requested when the row is new', async () => {
    const senderIdentity = buildSenderIdentity()
    const template = buildTemplate(senderIdentity.id.toString())
    const email = buildEmail()
    const createIfNotExists = vi.fn().mockResolvedValue(success({ email, created: true }))
    const emailRepository: EmailRepository = { createIfNotExists }
    const findByIdAndProjectId = vi.fn().mockResolvedValue(success({ template }))
    const templateLookup: TemplateLookupProvider = { findByIdAndProjectId }
    const senderIdentityCache: SenderIdentityCacheProvider = {
      get: vi.fn().mockResolvedValue(success(senderIdentity)),
      invalidate: vi.fn()
    }
    const enqueue = vi.fn().mockResolvedValue(success(undefined))
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      templateLookup,
      senderIdentityCache,
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: template.id.toString(),
      variables: { name: 'Ada' }
    })

    expect(result.isSuccess()).toBe(true)
    // Proves the *rendered* output and the *resolved* sender — not some other field — got persisted.
    expect(createIfNotExists).toHaveBeenCalledWith(
      expect.objectContaining({
        email: expect.objectContaining({
          templateId: template.id.toString(),
          senderIdentityId: senderIdentity.id.toString(),
          from: senderIdentity.email,
          to: 'recipient@example.com',
          subject: 'Hi Ada',
          html: '<p>Hi Ada</p>'
        })
      })
    )
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [event, options] = enqueue.mock.calls[0] as [
      { name: string; payload: unknown },
      { topic: string; key: string }
    ]
    expect(options.topic).toBe('email.send.requested')
    expect(event.payload).toMatchObject({
      organizationId: '01900000-0000-7000-8000-000000000002',
      projectId: '01900000-0000-7000-8000-000000000001',
      from: senderIdentity.email
    })
  })

  it('does not enqueue a second event when the row already existed (idempotent replay)', async () => {
    const senderIdentity = buildSenderIdentity()
    const template = buildTemplate(senderIdentity.id.toString())
    const email = buildEmail({ idempotencyKey: 'idem-1' })
    const createIfNotExists = vi.fn().mockResolvedValue(success({ email, created: false }))
    const emailRepository: EmailRepository = { createIfNotExists }
    const enqueue = vi.fn()
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      { findByIdAndProjectId: vi.fn().mockResolvedValue(success({ template })) },
      { get: vi.fn().mockResolvedValue(success(senderIdentity)), invalidate: vi.fn() },
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: template.id.toString(),
      variables: {},
      idempotencyKey: 'idem-1'
    })

    expect(result.isSuccess()).toBe(true)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('includes idempotencyKey in the enqueued payload when the row is new and one was supplied', async () => {
    const senderIdentity = buildSenderIdentity()
    const template = buildTemplate(senderIdentity.id.toString())
    const email = buildEmail({ idempotencyKey: 'idem-1' })
    const createIfNotExists = vi.fn().mockResolvedValue(success({ email, created: true }))
    const emailRepository: EmailRepository = { createIfNotExists }
    const enqueue = vi.fn().mockResolvedValue(success(undefined))
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      { findByIdAndProjectId: vi.fn().mockResolvedValue(success({ template })) },
      { get: vi.fn().mockResolvedValue(success(senderIdentity)), invalidate: vi.fn() },
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: template.id.toString(),
      variables: {},
      idempotencyKey: 'idem-1'
    })

    expect(result.isSuccess()).toBe(true)
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [event] = enqueue.mock.calls[0] as [{ payload: unknown }]
    expect(event.payload).toMatchObject({ idempotencyKey: 'idem-1' })
  })

  it('fails with TemplateNotFoundError when the templateId does not resolve for this project', async () => {
    const findByIdAndProjectId = vi.fn().mockResolvedValue(success({ template: null }))
    const templateLookup: TemplateLookupProvider = { findByIdAndProjectId }
    const createIfNotExists = vi.fn()
    const emailRepository: EmailRepository = { createIfNotExists }
    const outbox: OutboxPort = { enqueue: vi.fn() }
    const senderIdentityCache: SenderIdentityCacheProvider = { get: vi.fn(), invalidate: vi.fn() }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      templateLookup,
      senderIdentityCache,
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: 'missing-template',
      variables: {}
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(TemplateNotFoundError)
    expect(createIfNotExists).not.toHaveBeenCalled()
    expect(senderIdentityCache.get).not.toHaveBeenCalled()
  })

  it('fails with MissingTemplateVariableError and never persists when a variable is missing', async () => {
    const senderIdentity = buildSenderIdentity()
    const template = buildTemplate(senderIdentity.id.toString())
    const findByIdAndProjectId = vi.fn().mockResolvedValue(success({ template }))
    const templateLookup: TemplateLookupProvider = { findByIdAndProjectId }
    const createIfNotExists = vi.fn()
    const emailRepository: EmailRepository = { createIfNotExists }
    const outbox: OutboxPort = { enqueue: vi.fn() }
    const senderIdentityCache: SenderIdentityCacheProvider = {
      get: vi.fn().mockResolvedValue(success(senderIdentity)),
      invalidate: vi.fn()
    }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      templateLookup,
      senderIdentityCache,
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: template.id.toString(),
      variables: {}
    })

    expect(result.isFailure()).toBe(true)
    expect(createIfNotExists).not.toHaveBeenCalled()
  })

  it('fails with SenderIdentityNotVerifiedError and never persists when the sender identity is not verified', async () => {
    const senderIdentity = buildSenderIdentity({ verifiedAt: null })
    const template = buildTemplate(senderIdentity.id.toString())
    const findByIdAndProjectId = vi.fn().mockResolvedValue(success({ template }))
    const templateLookup: TemplateLookupProvider = { findByIdAndProjectId }
    const createIfNotExists = vi.fn()
    const emailRepository: EmailRepository = { createIfNotExists }
    const outbox: OutboxPort = { enqueue: vi.fn() }
    const senderIdentityCache: SenderIdentityCacheProvider = {
      get: vi.fn().mockResolvedValue(success(senderIdentity)),
      invalidate: vi.fn()
    }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      templateLookup,
      senderIdentityCache,
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: template.id.toString(),
      variables: { name: 'Ada' }
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(SenderIdentityNotVerifiedError)
    expect(createIfNotExists).not.toHaveBeenCalled()
  })

  it('fails with SenderIdentityNotVerifiedError when the sender identity no longer resolves', async () => {
    const template = buildTemplate('01900000-0000-7000-8000-000000000099')
    const findByIdAndProjectId = vi.fn().mockResolvedValue(success({ template }))
    const templateLookup: TemplateLookupProvider = { findByIdAndProjectId }
    const createIfNotExists = vi.fn()
    const emailRepository: EmailRepository = { createIfNotExists }
    const outbox: OutboxPort = { enqueue: vi.fn() }
    const senderIdentityCache: SenderIdentityCacheProvider = {
      get: vi.fn().mockResolvedValue(success(null)),
      invalidate: vi.fn()
    }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      templateLookup,
      senderIdentityCache,
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: template.id.toString(),
      variables: {}
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(SenderIdentityNotVerifiedError)
  })

  it('propagates a repository failure without enqueueing', async () => {
    const senderIdentity = buildSenderIdentity()
    const template = buildTemplate(senderIdentity.id.toString())
    const persistenceError = new CreateEmailError({ error: new Error('db down') })
    const createIfNotExists = vi.fn().mockResolvedValue(failure(persistenceError))
    const emailRepository: EmailRepository = { createIfNotExists }
    const enqueue = vi.fn()
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      { findByIdAndProjectId: vi.fn().mockResolvedValue(success({ template })) },
      { get: vi.fn().mockResolvedValue(success(senderIdentity)), invalidate: vi.fn() },
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: template.id.toString(),
      variables: {}
    })

    expect(result.isFailure()).toBe(true)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('fails with InvalidEmailPayloadError and never enqueues when the built payload fails schema validation', async () => {
    /*
     * "to" is the one field the caller still controls end-to-end — Email.create only checks it's
     * non-empty (not real email format), so this string clears the domain model but must still
     * trip the defensive safeParse backstop before any transaction opens.
     */
    const senderIdentity = buildSenderIdentity()
    const template = buildTemplate(senderIdentity.id.toString())
    const createIfNotExists = vi.fn()
    const emailRepository: EmailRepository = { createIfNotExists }
    const enqueue = vi.fn()
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      { findByIdAndProjectId: vi.fn().mockResolvedValue(success({ template })) },
      { get: vi.fn().mockResolvedValue(success(senderIdentity)), invalidate: vi.fn() },
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'not-an-email',
      templateId: template.id.toString(),
      variables: { name: 'Ada' }
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(InvalidEmailPayloadError)
    expect(createIfNotExists).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('rolls the transaction back to failure when the outbox enqueue fails on a newly created row', async () => {
    const senderIdentity = buildSenderIdentity()
    const template = buildTemplate(senderIdentity.id.toString())
    const email = buildEmail()
    const createIfNotExists = vi.fn().mockResolvedValue(success({ email, created: true }))
    const emailRepository: EmailRepository = { createIfNotExists }
    const enqueueError = new EnqueueOutboxMessageError({ error: new Error('kafka unreachable') })
    const enqueue = vi.fn().mockResolvedValue(failure(enqueueError))
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      { findByIdAndProjectId: vi.fn().mockResolvedValue(success({ template })) },
      { get: vi.fn().mockResolvedValue(success(senderIdentity)), invalidate: vi.fn() },
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      to: 'recipient@example.com',
      templateId: template.id.toString(),
      variables: {}
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(enqueueError)
  })
})
```

Run: `pnpm --filter @ruguin/core-server test -- send-email.use-case`
Expected: FAIL — `SendEmailUseCase`'s constructor doesn't accept a `SenderIdentityCacheProvider`
argument yet, and its input type still requires `from` and still allows the `subject`+`html`
branch.

- [ ] **Step 6: Update the use case**

Replace the full contents of `apps/core-server/src/modules/emails/application/use-cases/send-email.use-case.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'
import { EMAIL_SEND_REQUESTED_TOPIC, EmailSendRequestedPayloadSchema } from '@ruguin/event-schemas'
import { type BaseError, Event, ID, type JsonValue } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { OUTBOX_PORT, type OutboxPort } from '../../../../shared/domain/contracts/outbox.port'
import {
  TRANSACTION_MANAGER,
  type TransactionManager
} from '../../../../shared/domain/contracts/transaction-manager.contract'
import {
  SENDER_IDENTITY_CACHE_PROVIDER,
  type SenderIdentityCacheProvider
} from '../../../sender-identities/domain/contracts/sender-identity-cache.provider'
import { SenderIdentityNotVerifiedError } from '../../../sender-identities/domain/errors/sender-identity-not-verified.error'
import {
  TEMPLATE_LOOKUP_PROVIDER,
  type TemplateLookupProvider
} from '../../../templates/domain/contracts/template-lookup.provider'
import { TemplateNotFoundError } from '../../../templates/domain/errors/template-not-found.error'
import { renderTemplate } from '../../../templates/domain/render-template'
import { EMAIL_REPOSITORY, type EmailRepository } from '../../domain/contracts/repositories/email.repository'
import { InvalidEmailPayloadError } from '../../domain/errors/models/invalid-email-payload.error'
import { Email } from '../../domain/models/email.model'

export type SendEmailUseCaseInput = Readonly<{
  projectId: string
  organizationId: string
  to: string
  templateId: string
  variables: Record<string, string>
  idempotencyKey?: string
}>

@Injectable()
export class SendEmailUseCase {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly transactionManager: TransactionManager,
    @Inject(EMAIL_REPOSITORY) private readonly emailRepository: EmailRepository,
    @Inject(TEMPLATE_LOOKUP_PROVIDER) private readonly templateLookup: TemplateLookupProvider,
    @Inject(SENDER_IDENTITY_CACHE_PROVIDER) private readonly senderIdentityCache: SenderIdentityCacheProvider,
    @Inject(OUTBOX_PORT) private readonly outbox: OutboxPort
  ) {}

  public async execute(input: SendEmailUseCaseInput): Promise<Either<BaseError, Email>> {
    const templateResult = await this.templateLookup.findByIdAndProjectId({
      templateId: input.templateId,
      projectId: input.projectId
    })
    if (templateResult.isFailure()) return failure(templateResult.value)
    if (templateResult.value.template === null) {
      return failure(new TemplateNotFoundError({ templateId: input.templateId }))
    }
    const { template } = templateResult.value

    /*
     * Resolved from the cache-backed contract, not the raw repository — the send path is the hot
     * path this cache exists for (design spec decision 5). A miss (deleted row, cache/DB
     * disagreement) is treated exactly like "not verified": there is no legitimate send without a
     * resolvable, verified sender.
     */
    const senderIdentityResult = await this.senderIdentityCache.get({ senderIdentityId: template.senderIdentityId })
    if (senderIdentityResult.isFailure()) return failure(senderIdentityResult.value)
    const senderIdentity = senderIdentityResult.value
    if (senderIdentity === null || !senderIdentity.isVerified()) {
      return failure(new SenderIdentityNotVerifiedError({ senderIdentityId: template.senderIdentityId }))
    }

    const rendered = renderTemplate({ subject: template.subject, html: template.html, variables: input.variables })
    if (rendered.isFailure()) return failure(rendered.value)

    const idGenerated = ID.generate({ modelName: 'Email' })
    if (idGenerated.isFailure()) {
      /*
       * Same posture as Event.create(): UUID generation itself failing is treated as a bug, not
       * an expected domain failure — there is no meaningful recovery for the caller here.
       */
      throw new Error(`Failed to generate an id for a new email: ${idGenerated.value.message}`)
    }

    const emailResult = Email.create({
      id: idGenerated.value.idGenerated,
      projectId: input.projectId,
      templateId: input.templateId,
      senderIdentityId: senderIdentity.id.toString(),
      idempotencyKey: input.idempotencyKey ?? null,
      from: senderIdentity.email,
      to: input.to,
      subject: rendered.value.subject,
      html: rendered.value.html,
      createdAt: new Date()
    })
    if (emailResult.isFailure()) return emailResult

    /*
     * Validated up front, from the not-yet-persisted email, so a malformed payload never opens a
     * DB transaction. safeParse (never .parse()) keeps this an Either failure, matching the
     * method's own contract, instead of a throw that would otherwise surface as a generic 500.
     */
    const payloadParsed = EmailSendRequestedPayloadSchema.safeParse({
      emailId: emailResult.value.id.toString(),
      organizationId: input.organizationId,
      projectId: emailResult.value.projectId,
      from: emailResult.value.from,
      to: emailResult.value.to,
      subject: emailResult.value.subject,
      html: emailResult.value.html,
      ...(emailResult.value.idempotencyKey !== null && { idempotencyKey: emailResult.value.idempotencyKey })
    })
    if (!payloadParsed.success) return failure(new InvalidEmailPayloadError({ error: payloadParsed.error }))

    /*
     * z.infer makes `idempotencyKey` `string | undefined` (Zod's `.optional()` convention), which
     * JsonValue's index signature rejects even though Zod never emits the key holding `undefined`
     * — it's simply absent when not supplied. The cast bridges that TypeScript-only mismatch;
     * safeParse above already did the real runtime validation.
     */
    const payload = payloadParsed.data as JsonValue

    return this.transactionManager.execute(async (tx) => {
      const persistResult = await this.emailRepository.createIfNotExists({ email: emailResult.value, tx })
      if (persistResult.isFailure()) return failure(persistResult.value)

      const { email: persisted, created } = persistResult.value

      if (created) {
        const event = Event.create(EMAIL_SEND_REQUESTED_TOPIC, payload)
        const enqueued = await this.outbox.enqueue(
          event,
          { topic: EMAIL_SEND_REQUESTED_TOPIC, key: persisted.projectId },
          tx
        )
        if (enqueued.isFailure()) return failure(enqueued.value)
      }

      return success(persisted)
    })
  }
}
```

- [ ] **Step 7: Run the use case test to verify it passes**

Run: `pnpm --filter @ruguin/core-server test -- send-email.use-case`
Expected: PASS (10 tests).

- [ ] **Step 8: Update the controller unit test**

Replace the full contents of `apps/core-server/src/modules/emails/presentation/controllers/__tests__/email.controller.unit.ts`:

```ts
import { ID } from '@ruguin/shared-domain'
import { success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type SendEmailService } from '../../../application/services/send-email.service'
import { InvalidSendEmailRequestError } from '../../../domain/errors/models/invalid-send-email-request.error'
import { Email } from '../../../domain/models/email.model'
import { EmailController } from '../email.controller'

/*
 * SendEmailService's constructor-injected sendEmailUseCase is `private`, so TS treats it as part
 * of the class's structural shape when checking an object literal against `SendEmailService`
 * itself — the literal below has no way to supply that field and fails to type-check. Picking only
 * the public method keeps the fake typed against the same contract EmailController actually calls.
 */
type SendEmailServiceLike = Pick<SendEmailService, 'execute'>

function validId(): ID {
  const generated = ID.generate({ modelName: 'Email' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildEmail() {
  const result = Email.create({
    id: validId(),
    projectId: 'project-1',
    templateId: 'template-1',
    senderIdentityId: 'sender-1',
    idempotencyKey: null,
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Hi',
    html: '<p>Hi</p>',
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

const VALID_BODY = { to: 'recipient@example.com', templateId: '0198f3b2-1234-7000-8000-000000000020', variables: {} }

describe('EmailController#send', () => {
  it('returns { id, status: "queued" } on success', async () => {
    const email = buildEmail()
    const service: SendEmailServiceLike = { execute: vi.fn().mockResolvedValue(success(email)) }
    const controller = new EmailController(service as SendEmailService)

    const response = await controller.send(VALID_BODY, undefined, { projectId: 'project-1', organizationId: 'org-1' })

    expect(response).toEqual({ id: email.id.toString(), status: 'queued' })
  })

  it.each([
    ['an absent header', undefined],
    ['an empty header', ''],
    ['a whitespace-only header', ' '.repeat(3)]
  ])('forwards no idempotencyKey at all for %s', async (_label, header) => {
    /*
     * '' is what an `Idempotency-Key:` with no value actually arrives as, and it is not a key: it
     * would survive the use case's `?? null` and only die at the outbox payload's min(1) as a 500.
     */
    const email = buildEmail()
    const service: SendEmailServiceLike = { execute: vi.fn().mockResolvedValue(success(email)) }
    const controller = new EmailController(service as SendEmailService)

    await controller.send(VALID_BODY, header, { projectId: 'project-1', organizationId: 'org-1' })

    expect(service.execute).toHaveBeenCalledWith(expect.not.objectContaining({ idempotencyKey: expect.anything() }))
  })

  it('forwards a non-blank Idempotency-Key header untouched', async () => {
    const email = buildEmail()
    const service: SendEmailServiceLike = { execute: vi.fn().mockResolvedValue(success(email)) }
    const controller = new EmailController(service as SendEmailService)

    await controller.send(VALID_BODY, 'idem-1', { projectId: 'project-1', organizationId: 'org-1' })

    expect(service.execute).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'idem-1' }))
  })

  it('throws InvalidSendEmailRequestError for a body missing templateId', async () => {
    const service: SendEmailServiceLike = { execute: vi.fn() }
    const controller = new EmailController(service as SendEmailService)

    await expect(
      controller.send({ to: 'recipient@example.com' }, undefined, { projectId: 'project-1', organizationId: 'org-1' })
    ).rejects.toBeInstanceOf(InvalidSendEmailRequestError)
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('throws whatever BaseError the service returns as a failure', async () => {
    class FakeError extends Error {}
    const service: SendEmailServiceLike = {
      execute: vi.fn().mockResolvedValue({ isFailure: () => true, isSuccess: () => false, value: new FakeError() })
    }
    const controller = new EmailController(service as SendEmailService)

    await expect(
      controller.send(VALID_BODY, undefined, { projectId: 'project-1', organizationId: 'org-1' })
    ).rejects.toBeInstanceOf(FakeError)
  })
})
```

Run: `pnpm --filter @ruguin/core-server test -- email.controller.unit`
Expected: PASS (6 tests).

- [ ] **Step 9: Wire `SenderIdentitiesModule` into `EmailsModule`**

Replace the full contents of `apps/core-server/src/modules/emails/emails.module.ts`:

```ts
import { Module } from '@nestjs/common'

import { OutboxModule } from '../../shared/infrastructure/outbox/outbox.module'
import { ApiKeysModule } from '../api-keys/api-keys.module'
import { SenderIdentitiesModule } from '../sender-identities/sender-identities.module'
import { TemplatesModule } from '../templates/templates.module'

import { SendEmailService } from './application/services/send-email.service'
import { SendEmailUseCase } from './application/use-cases/send-email.use-case'
import { EMAIL_REPOSITORY } from './domain/contracts/repositories/email.repository'
import { EmailRepository } from './infrastructure/database/prisma/email.repository'
import { EmailController } from './presentation/controllers/email.controller'

@Module({
  imports: [ApiKeysModule, TemplatesModule, SenderIdentitiesModule, OutboxModule.forFeature({ module: 'email' })],
  controllers: [EmailController],
  providers: [
    EmailRepository,
    { provide: EMAIL_REPOSITORY, useExisting: EmailRepository },
    SendEmailUseCase,
    SendEmailService
  ]
})
export class EmailsModule {}
```

- [ ] **Step 10: Run the full core-server test suite, type check, and lint**

Run: `pnpm --filter @ruguin/core-server test && pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/core-server check:lint`
Expected: unit tests PASS. e2e is expected to still fail — Task 13 rewrites it.

- [ ] **Step 11: Commit**

```bash
git add apps/core-server
git commit -m "feat(core-server): resolve and enforce sender identity on send"
```

---

### Task 12: `fromName` — display name through to the actual sent email

**Files:**

- Modify: `packages/event-schemas/src/email-send-requested.schema.ts`
- Test: `packages/event-schemas/src/__tests__/email-send-requested.schema.unit.ts` (modify)
- Modify: `apps/core-server/src/modules/emails/application/use-cases/send-email.use-case.ts`
- Test: `apps/core-server/src/modules/emails/application/use-cases/__tests__/send-email.use-case.unit.ts` (modify)
- Modify: `apps/dispatch-worker/src/email/application/providers/email-sender.port.ts`
- Modify: `apps/dispatch-worker/src/email/application/use-cases/send-email.use-case.ts`
- Modify: `apps/dispatch-worker/src/email/infra/ses/ses-email-sender.ts`
- Test: `apps/dispatch-worker/src/email/infra/ses/__tests__/ses-email-sender.unit.ts` (modify)

**Interfaces:**

- Produces: `EmailSendRequestedPayloadSchema` gains `fromName?: string` — both consumers
  (`email-send-requested.consumer.ts`, `email-send-requested-retry.consumer.ts`) already spread the
  whole parsed payload into `SendEmailUseCase.execute(...)`, so neither needs a code change.

- [ ] **Step 1: Add `fromName` to the shared event schema**

In `packages/event-schemas/src/email-send-requested.schema.ts`, add one field:

```ts
export const EmailSendRequestedPayloadSchema = z.object({
  emailId: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  from: z.email(),
  fromName: z.string().min(1).optional(),
  to: z.email(),
  subject: z.string().min(1),
  html: z.string().min(1),
  idempotencyKey: z.string().min(1).optional()
})
```

In `packages/event-schemas/src/__tests__/email-send-requested.schema.unit.ts`, add one test right
after `'accepts a valid payload with an optional idempotencyKey'`:

```ts
  it('accepts a valid payload with an optional fromName', () => {
    const result = EmailSendRequestedPayloadSchema.safeParse({ ...validPayload, fromName: 'Will Gravina' })

    expect(result.success).toBe(true)
  })
```

Run: `pnpm --filter @ruguin/event-schemas test:unit`
Expected: PASS.

- [ ] **Step 2: core-server: send the resolved sender's display name**

In `apps/core-server/src/modules/emails/application/use-cases/send-email.use-case.ts`, add
`fromName` to the payload object built for `EmailSendRequestedPayloadSchema.safeParse`:

```ts
    const payloadParsed = EmailSendRequestedPayloadSchema.safeParse({
      emailId: emailResult.value.id.toString(),
      organizationId: input.organizationId,
      projectId: emailResult.value.projectId,
      from: emailResult.value.from,
      fromName: senderIdentity.name,
      to: emailResult.value.to,
      subject: emailResult.value.subject,
      html: emailResult.value.html,
      ...(emailResult.value.idempotencyKey !== null && { idempotencyKey: emailResult.value.idempotencyKey })
    })
```

In `apps/core-server/src/modules/emails/application/use-cases/__tests__/send-email.use-case.unit.ts`,
extend the `event.payload` assertion in the first test
(`'renders the template, persists the email, and enqueues email.send.requested when the row is new'`):

```ts
    expect(event.payload).toMatchObject({
      organizationId: '01900000-0000-7000-8000-000000000002',
      projectId: '01900000-0000-7000-8000-000000000001',
      from: senderIdentity.email,
      fromName: senderIdentity.name
    })
```

Run: `pnpm --filter @ruguin/core-server test -- send-email.use-case`
Expected: PASS.

- [ ] **Step 3: dispatch-worker: thread `fromName` through the port and use case**

In `apps/dispatch-worker/src/email/application/providers/email-sender.port.ts`:

```ts
export type SendEmailInput = Readonly<{ from: string; fromName?: string; to: string; subject: string; html: string }>
```

In `apps/dispatch-worker/src/email/application/use-cases/send-email.use-case.ts`, add `fromName` to
`SendEmailUseCaseInput`:

```ts
export type SendEmailUseCaseInput = Readonly<{
  emailId: string
  organizationId: string
  projectId: string
  from: string
  fromName?: string | undefined
  to: string
  subject: string
  html: string
  idempotencyKey?: string | undefined
  attempt: number
}>
```

And in `processClaimedAttempt`, pass it through conditionally (`exactOptionalPropertyTypes` is on —
never spread an explicit `undefined`):

```ts
    const sent = await this.emailSender.send({
      from: input.from,
      ...(input.fromName !== undefined && { fromName: input.fromName }),
      to: input.to,
      subject: input.subject,
      html: input.html
    })
```

- [ ] **Step 4: Write the failing SES sender test**

In `apps/dispatch-worker/src/email/infra/ses/__tests__/ses-email-sender.unit.ts`, add one test right
after `'sends the email and returns the SES message id'`:

```ts
  it('formats Source as "Name <email>" when fromName is provided', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: 'ses-msg-2' })
    const sender = new SesEmailSender(fakeSesClient(send))

    await sender.send({
      from: 'a@ruguin.dev',
      fromName: 'Will Gravina',
      to: 'b@ruguin.dev',
      subject: 'Hi',
      html: '<p>Hi</p>'
    })

    const command = send.mock.calls[0]?.[0] as SendEmailCommand
    expect(command.input.Source).toBe('Will Gravina <a@ruguin.dev>')
  })
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm --filter @ruguin/dispatch-worker test -- ses-email-sender`
Expected: FAIL — `Source` is still always `input.from`, ignoring `fromName`.

- [ ] **Step 6: Update `SesEmailSender`**

In `apps/dispatch-worker/src/email/infra/ses/ses-email-sender.ts`, change one line inside
`SendEmailCommand`:

```ts
      const response = await this.client.send(
        new SendEmailCommand({
          Source: input.fromName !== undefined ? `${input.fromName} <${input.from}>` : input.from,
          Destination: { ToAddresses: [input.to] },
          Message: {
            Subject: { Data: input.subject },
            Body: { Html: { Data: input.html } }
          }
        })
      )
```

- [ ] **Step 7: Run the dispatch-worker test suite and type check**

Run: `pnpm --filter @ruguin/dispatch-worker test && pnpm --filter @ruguin/dispatch-worker check:types`
Expected: PASS.

- [ ] **Step 8: Run the full monorepo type check**

Run: `pnpm --filter @ruguin/event-schemas check:types && pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/dispatch-worker check:types`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/event-schemas apps/core-server apps/dispatch-worker
git commit -m "feat: carry sender display name through to the sent email"
```

---

### Task 13: e2e wiring — seeded sender identity, rewritten `/v1/emails` e2e, new `/sender-identities` e2e

**Files:**

- Modify: `packages/env/src/packages/test-seed.environment.ts`
- Modify: `apps/core-server/vitest.setup.e2e.ts`
- Test: `apps/core-server/src/modules/emails/presentation/controllers/__tests__/email.controller.e2e.ts` (modify)
- Test: `apps/core-server/src/modules/sender-identities/presentation/controllers/__tests__/sender-identity.controller.e2e.ts` (create)

**Interfaces:**

- Consumes: everything from Tasks 1–12. This is the final integration point — every piece gets
  exercised together for the first time here.

- [ ] **Step 1: Add `TEST_SEEDED_SENDER_IDENTITY_ID`**

In `packages/env/src/packages/test-seed.environment.ts`, add one field:

```ts
export const testSeedENV = lazyEnvironment(() =>
  createEnv({
    server: {
      TEST_SEEDED_ORGANIZATION_ID: z.string().min(1),
      TEST_SEEDED_PROJECT_ID: z.string().min(1),
      TEST_SEEDED_SENDER_IDENTITY_ID: z.string().min(1),
      TEST_SEEDED_TEMPLATE_ID: z.string().min(1),
      TEST_SEEDED_API_KEY: z.string().min(1)
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
```

- [ ] **Step 2: Update `vitest.setup.e2e.ts`**

Replace the full contents of `apps/core-server/vitest.setup.e2e.ts`:

```ts
import { execSync } from 'node:child_process'

process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin?schema=core_server'
process.env.ENVIRONMENT ??= 'test'
/*
 * app.module.ts now wires MessageBrokerModule (publishing side of the outbox→dispatch-worker
 * flow) — matches apps/dispatch-worker's own docker-compose Kafka listener.
 */
process.env.KAFKA_BOOTSTRAP_BROKERS ??= 'localhost:9092'
/*
 * CACHE_PREFIX has no default in cacheENV's schema (packages/env) — CACHE_DRIVER is left unset
 * so it falls back to 'memory', keeping the e2e suite self-sufficient without a live Valkey.
 */
process.env.CACHE_PREFIX ??= 'ruguin-core-server-e2e'
/*
 * docsENV requires both with no default (packages/env/src/packages/docs.environment.ts). Test-only
 * Basic Auth credentials for the /docs routes this suite never authenticates against — not a
 * secret, just what coreServerENV needs present to resolve at all.
 */
process.env.DOCS_USERNAME ??= 'e2e-test'
process.env.DOCS_PASSWORD ??= 'e2e-test'
/*
 * awsENV's own fields all default or are optional except these — the SES v2 client (sender
 * identity registration) needs them to point at LocalStack instead of real AWS during e2e.
 * 'test'/'test' is the same placeholder value packages/env's own aws.environment.unit.ts already
 * uses for the identical purpose.
 */
process.env.AWS_ENDPOINT_URL ??= 'http://localhost:4566'
process.env.AWS_ACCESS_KEY_ID ??= 'test'
process.env.AWS_SECRET_ACCESS_KEY ??= 'test'

// eslint-disable-next-line sonarjs/no-os-command-from-path -- static command, no interpolated input; `pnpm exec` is the intended way to resolve workspace-local binaries via PATH.
const seedOutput = execSync('pnpm exec tsx prisma/seed.ts', {
  cwd: new URL('.', import.meta.url).pathname,
  env: process.env,
  encoding: 'utf8'
})

const organizationId = /organizationId:\s+(\S+)/.exec(seedOutput)?.[1]
const projectId = /projectId:\s+(\S+)/.exec(seedOutput)?.[1]
const senderIdentityId = /senderIdentityId:\s+(\S+)/.exec(seedOutput)?.[1]
const templateId = /templateId:\s+(\S+)/.exec(seedOutput)?.[1]
const apiKey = /API key:\s+(\S+)/.exec(seedOutput)?.[1]

/*
 * Report which fields failed to parse, never the raw output — it carries the seeded API key in
 * cleartext, and this message can land in a CI log with far wider, longer-lived reach than the
 * terminal it was meant for.
 */
if (
  organizationId === undefined ||
  projectId === undefined ||
  senderIdentityId === undefined ||
  templateId === undefined ||
  apiKey === undefined
) {
  const missing = Object.entries({ organizationId, projectId, senderIdentityId, templateId, apiKey })
    .filter(([, value]) => value === undefined)
    .map(([name]) => name)
  throw new Error(`Failed to parse seed output — missing: ${missing.join(', ')}.`)
}

process.env.TEST_SEEDED_ORGANIZATION_ID = organizationId
process.env.TEST_SEEDED_PROJECT_ID = projectId
process.env.TEST_SEEDED_SENDER_IDENTITY_ID = senderIdentityId
process.env.TEST_SEEDED_TEMPLATE_ID = templateId
process.env.TEST_SEEDED_API_KEY = apiKey
```

- [ ] **Step 3: Rewrite `email.controller.e2e.ts` for the minimalist body**

Replace the full contents of `apps/core-server/src/modules/emails/presentation/controllers/__tests__/email.controller.e2e.ts`:

```ts
import { randomUUID } from 'node:crypto'

import { type NestFastifyApplication } from '@nestjs/platform-fastify'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { testSeedENV } from '@ruguin/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AppModule } from '../../../../../app.module'
import { configureApp } from '../../../../../shared/infrastructure/bootstrap/configure-app'
import { PrismaService } from '../../../../../shared/infrastructure/database/prisma/prisma.service'

const SEEDED_TEMPLATE_ID = testSeedENV.TEST_SEEDED_TEMPLATE_ID
const SEEDED_API_KEY = testSeedENV.TEST_SEEDED_API_KEY
const SEEDED_PROJECT_ID = testSeedENV.TEST_SEEDED_PROJECT_ID

describe('POST /v1/emails (e2e)', () => {
  let app: NestFastifyApplication

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await configureApp(app)
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  // --- EMAIL-3 acceptance criteria ---

  it('returns 401 for a request with no Authorization header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      payload: { to: 'recipient@example.com', templateId: SEEDED_TEMPLATE_ID, variables: {} }
    })

    expect(response.statusCode).toBe(401)
  })

  it('returns 401 for an unknown API key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: 'Bearer not-a-real-key' },
      payload: { to: 'recipient@example.com', templateId: SEEDED_TEMPLATE_ID, variables: {} }
    })

    expect(response.statusCode).toBe(401)
  })

  it('GET /health responds 200 without any authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
  })

  // --- EMAIL-4 acceptance criteria ---

  it('accepts a templateId + variables request, persists the rendered content, and returns 202', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { to: 'recipient@example.com', templateId: SEEDED_TEMPLATE_ID, variables: { name: 'Ada' } }
    })

    expect(response.statusCode).toBe(202)
    const body = JSON.parse(response.body) as { id: string; status: string }
    expect(body).toMatchObject({ status: 'queued' })

    /*
     * The seeded template (prisma/seed.ts) is subject 'Hi {{name}}' / html '<p>Hi {{name}}</p>' —
     * asserting the persisted row, not just the 202, is what actually proves rendering happened.
     */
    const prisma = app.get(PrismaService)
    const row = await prisma.email.findUnique({ where: { id: body.id } })
    expect(row?.subject).toBe('Hi Ada')
    expect(row?.html).toBe('<p>Hi Ada</p>')
  })

  it('returns 400 when the body is missing templateId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { to: 'recipient@example.com' }
    })

    expect(response.statusCode).toBe(400)
  })

  it('returns 404 for a templateId that does not exist at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { to: 'recipient@example.com', templateId: randomUUID(), variables: {} }
    })

    expect(response.statusCode).toBe(404)
  })

  it('returns 404 for a templateId that exists but belongs to a different project', async () => {
    /*
     * A random UUID alone only proves "nonexistent template" → 404, not multi-tenant isolation.
     * This seeds a second, genuinely different project + sender identity + template so the
     * assertion actually exercises the `WHERE projectId = ...` scoping in TemplateLookupProvider,
     * not just a not-found path that would also fire for a typo.
     */
    const prisma = app.get(PrismaService)
    const otherOrganization = await prisma.organization.create({ data: { name: 'Other Org' } })
    const otherProject = await prisma.project.create({
      data: { organizationId: otherOrganization.id, name: 'Other Project' }
    })
    const otherSenderIdentity = await prisma.senderIdentity.create({
      data: {
        projectId: otherProject.id,
        name: 'Other Sender',
        email: `other+${randomUUID()}@example.com`,
        verifiedAt: new Date()
      }
    })
    const otherTemplate = await prisma.template.create({
      data: {
        projectId: otherProject.id,
        senderIdentityId: otherSenderIdentity.id,
        name: 'Other Template',
        subject: 'Hi',
        html: '<p>Hi</p>'
      }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { to: 'recipient@example.com', templateId: otherTemplate.id, variables: {} }
    })

    expect(response.statusCode).toBe(404)
  })

  it('returns 422 when the template references a variable that was not provided', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { to: 'recipient@example.com', templateId: SEEDED_TEMPLATE_ID, variables: {} }
    })

    expect(response.statusCode).toBe(422)
  })

  it('returns 422 when the template points at a sender identity that is not verified', async () => {
    const prisma = app.get(PrismaService)
    const unverifiedSenderIdentity = await prisma.senderIdentity.create({
      data: {
        projectId: SEEDED_PROJECT_ID,
        name: 'Unverified Sender',
        email: `unverified+${randomUUID()}@example.com`,
        verifiedAt: null
      }
    })
    const templateWithUnverifiedSender = await prisma.template.create({
      data: {
        projectId: SEEDED_PROJECT_ID,
        senderIdentityId: unverifiedSenderIdentity.id,
        name: 'Unverified Sender Template',
        subject: 'Hi',
        html: '<p>Hi</p>'
      }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { to: 'recipient@example.com', templateId: templateWithUnverifiedSender.id, variables: {} }
    })

    expect(response.statusCode).toBe(422)
  })

  it('accepts a request whose Idempotency-Key header is present but empty', async () => {
    /*
     * An empty header value is not a key. Forwarded as one it survives every layer's null check
     * and only fails at the outbox payload's z.string().min(1), surfacing as a 500.
     */
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}`, 'idempotency-key': '' },
      payload: { to: 'recipient@example.com', templateId: SEEDED_TEMPLATE_ID, variables: { name: 'Ada' } }
    })

    expect(response.statusCode).toBe(202)
  })

  it('returns 409 when an Idempotency-Key is reused with a different body', async () => {
    /*
     * Answering the second request with the first email's id would report 202 for a message that
     * is never queued and never sent — silent, permanent loss disguised as success. Same
     * templateId, different variables → different rendered content, which is what the repository
     * actually compares.
     */
    const idempotencyKey = `idem-${randomUUID()}`
    const headers = { authorization: `Bearer ${SEEDED_API_KEY}`, 'idempotency-key': idempotencyKey }

    const first = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers,
      payload: { to: 'first@example.com', templateId: SEEDED_TEMPLATE_ID, variables: { name: 'Ada' } }
    })
    const second = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers,
      payload: { to: 'second@example.com', templateId: SEEDED_TEMPLATE_ID, variables: { name: 'Bob' } }
    })

    expect(first.statusCode).toBe(202)
    expect(second.statusCode).toBe(409)
    expect(JSON.parse(second.body).error).toBe('EmailIdempotencyConflictError')

    const prisma = app.get(PrismaService)
    const rows = await prisma.email.findMany({ where: { idempotencyKey } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.to).toBe('first@example.com')
  })

  it('returns the same id for two concurrent requests sharing an Idempotency-Key', async () => {
    const idempotencyKey = `idem-${randomUUID()}`
    const payload = { to: 'recipient@example.com', templateId: SEEDED_TEMPLATE_ID, variables: { name: 'Ada' } }

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/emails',
        headers: { authorization: `Bearer ${SEEDED_API_KEY}`, 'idempotency-key': idempotencyKey },
        payload
      }),
      app.inject({
        method: 'POST',
        url: '/v1/emails',
        headers: { authorization: `Bearer ${SEEDED_API_KEY}`, 'idempotency-key': idempotencyKey },
        payload
      })
    ])

    expect(first.statusCode).toBe(202)
    expect(second.statusCode).toBe(202)
    expect(JSON.parse(first.body).id).toBe(JSON.parse(second.body).id)
  })
})
```

- [ ] **Step 4: Write the new sender-identity e2e test**

Create `apps/core-server/src/modules/sender-identities/presentation/controllers/__tests__/sender-identity.controller.e2e.ts`:

```ts
import { randomUUID } from 'node:crypto'

import { type NestFastifyApplication } from '@nestjs/platform-fastify'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { testSeedENV } from '@ruguin/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AppModule } from '../../../../../app.module'
import { configureApp } from '../../../../../shared/infrastructure/bootstrap/configure-app'

const SEEDED_API_KEY = testSeedENV.TEST_SEEDED_API_KEY
const SEEDED_SENDER_IDENTITY_ID = testSeedENV.TEST_SEEDED_SENDER_IDENTITY_ID

/*
 * These tests call the real AwsSesIdentityProvider, pointed at LocalStack via AWS_ENDPOINT_URL
 * (vitest.setup.e2e.ts). dispatch-worker's own e2e suite already exercises VerifyEmailIdentityCommand
 * (SES v1) against the same LocalStack instance successfully; CreateEmailIdentityCommand/
 * GetEmailIdentityCommand (SES v2) are assumed to have equivalent support — flagged as an open risk
 * in the design spec, to be confirmed here rather than assumed silently.
 */
describe('POST /sender-identities, GET /sender-identities (e2e)', () => {
  let app: NestFastifyApplication

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await configureApp(app)
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 401 for a request with no Authorization header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sender-identities',
      payload: { name: 'Will Gravina', email: `will+${randomUUID()}@gravina.dev` }
    })

    expect(response.statusCode).toBe(401)
  })

  it('returns 400 for a body missing email', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sender-identities',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { name: 'Will Gravina' }
    })

    expect(response.statusCode).toBe(400)
  })

  it('registers a new sender identity and returns it unverified', async () => {
    const email = `will+${randomUUID()}@gravina.dev`

    const response = await app.inject({
      method: 'POST',
      url: '/sender-identities',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { name: 'Will Gravina', email }
    })

    expect(response.statusCode).toBe(201)
    const body = JSON.parse(response.body) as {
      id: string
      name: string
      email: string
      domain: string
      verifiedAt: string | null
    }
    expect(body).toMatchObject({ name: 'Will Gravina', email, domain: 'gravina.dev', verifiedAt: null })
  })

  it('returns 409 when the same email is registered twice', async () => {
    const email = `duplicate+${randomUUID()}@gravina.dev`
    const first = await app.inject({
      method: 'POST',
      url: '/sender-identities',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { name: 'Will Gravina', email }
    })
    expect(first.statusCode).toBe(201)

    const second = await app.inject({
      method: 'POST',
      url: '/sender-identities',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { name: 'Will Gravina (again)', email }
    })

    expect(second.statusCode).toBe(409)
  })

  it('lists the seeded sender identity for the authenticated project', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/sender-identities',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` }
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body) as Array<{ id: string }>
    expect(body.some((senderIdentity) => senderIdentity.id === SEEDED_SENDER_IDENTITY_ID)).toBe(true)
  })
})
```

- [ ] **Step 5: Bring up LocalStack alongside Postgres for this run**

Run: `LOCALSTACK_AUTH_TOKEN=dummy docker compose -f infrastructure/local/docker-compose.yml up -d postgres localstack`
(a real free token, per `infrastructure/local/.env.example`, is needed for LocalStack features
beyond the free tier — SES identity management is expected to be in the free tier, but this is the
same open risk noted in the design spec)

- [ ] **Step 6: Run the full e2e suite**

Run: `pnpm --filter @ruguin/core-server test:e2e`
Expected: PASS, with a completely empty shell environment (no `.env`, no `pnpm with-env`) —
`vitest.setup.e2e.ts` alone must be sufficient, matching this session's earlier fix. If the two new
`sender-identity.controller.e2e.ts` tests that call SES fail specifically with `500` (not `400`/`401`/
`409`/`404`), read the logged cause (`BaseErrorExceptionFilter` logs every 5xx) — this is where the
LocalStack SES v2 support risk would surface. Report back rather than weakening the assertions to
work around it.

- [ ] **Step 7: Run the full core-server suite, type check, and lint one more time**

Run: `pnpm --filter @ruguin/core-server test && pnpm --filter @ruguin/core-server test:integration && pnpm --filter @ruguin/core-server test:e2e && pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/core-server check:lint`
Expected: everything PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/env apps/core-server
git commit -m "test(core-server): e2e coverage for sender identity registration and enforcement"
```

---

## Final verification

After Task 13, run the full monorepo suite once, from the repo root, with a completely empty shell
environment (matching how `.husky/pre-push` actually invokes it):

```bash
env -i PATH="$PATH" HOME="$HOME" pnpm test
```

Expected: PASS across all 8 packages (`turbo run test:all`), same bar this session already
established for the pre-existing suite. This is also the moment to update
`docs/product-spec.md`'s `/domains`-adjacent row (line ~168) if it should now reference
`/sender-identities` — check with the user before editing product-spec.md, it is out of this plan's
explicit scope (design spec, "Fora de escopo" — no product-spec update was requested).
