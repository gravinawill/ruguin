# Core Server — Autenticação multi-tenant e envio de email (EMAIL-3 + EMAIL-4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `apps/core-server` real multi-tenant auth (API key → project → organization) and a
working, idempotent `POST /emails` that publishes `email.send.requested` through the existing
outbox — closing the gap that leaves `apps/dispatch-worker` complete but fed by nothing real.

**Architecture:** Five new NestJS modules under `apps/core-server/src/modules/` (`organizations`,
`projects`, `api-keys`, `templates`, and filling in the already-scaffolded `emails`), each with its
own Prisma table, following the existing outbox module's contract/adapter/DI-token pattern. Reads
across module boundaries go through a `*LookupProvider` contract, never a direct repository import.
`POST /emails` writes the `Email` row and enqueues the outbox event in one transaction, using the
same `TransactionManager`/`OutboxPort` the outbox-pattern plan already built.

**Tech Stack:** NestJS 11 + Fastify, Prisma 7 (`@prisma/adapter-pg`), Zod 4.4.3, `@ruguin/cache`
(`GetOrSetCacheProvider`), `@ruguin/event-schemas` (`EmailSendRequestedPayloadSchema`), Vitest 4
(unit/integration/e2e projects already configured).

## Global Constraints

- **Module folders are plural**, matching the one real precedent already in the repo
  (`apps/core-server/src/modules/emails/`), not the singular list in `apps/core-server/CLAUDE.md`:
  `organizations`, `projects`, `api-keys`, `templates`, `emails`.
- **Follow the folder shape already scaffolded under `modules/emails/`** — `domain/`
  (`models/`, `errors/models/`, `errors/value-objects/`, `contracts/repositories/`, `enums/`,
  `value-objects/`), `application/` (`use-cases/`, `services/`, `listeners/`), `infrastructure/`,
  `presentation/` (`controllers/`, `dtos/`, `routes/`) — this is what is actually on disk, not the
  `domain/application/infra` layout described in `CLAUDE.md`, which predates this scaffold. The four
  new modules (`organizations`/`projects`/`api-keys`/`templates`) have no HTTP surface in this plan,
  so they only need `domain/` (`models/`, `errors/`, `contracts/`) and `infrastructure/`.
- **Every `Either`-returning function has an explicit return type annotation** — `success(x)` alone
  infers `Either<unknown, X>`.
- **Repository code casts `tx as unknown as Prisma.TransactionClient`** exactly like
  `apps/core-server/src/shared/infrastructure/outbox/outbox.repository.ts:17` — no other cast to a
  Prisma type is introduced.
- **`StatusError` → HTTP status mapping** (used by Task 2, referenced by every later error):
  `INVALID_INPUT`→400, `UNAUTHORIZED`→401, `FORBIDDEN`→403, `NOT_FOUND`→404, `CONFLICT`→409,
  `UNPROCESSABLE`→422, `TOO_MANY_REQUESTS`→429, `INTERNAL_ERROR`→500.
- **API key hash: SHA-256** (`node:crypto`), never bcrypt/argon2 — see design spec decision 3.
- **Zod `4.4.3`** for request validation — same version already pinned in
  `packages/event-schemas/package.json` and `packages/env/package.json`.
- **Tests**: `*.unit.ts` (no I/O), `*.int.ts` (real Postgres via `docker compose up -d`, see
  `apps/core-server/src/shared/infrastructure/outbox/__tests__/outbox-test-context.ts` for the
  `TEST_DATABASE_URL` helper), `*.e2e.ts` (built-app HTTP, `vitest.setup.e2e.ts` already forces
  `DATABASE_URL`). Every module's tests live in `__tests__/` beside the code they cover.
- Every `pnpm --filter @ruguin/core-server ...` command below assumes the working directory is the
  repo root.

---

### Task 1: `API_KEY_CACHE_TTL_IN_SECONDS` env var

**Files:**
- Modify: `packages/env/src/apps/core-server.environment.ts`
- Test: `packages/env/src/apps/__tests__/core-server.environment.unit.ts`

**Interfaces:**
- Produces: `coreServerENV.API_KEY_CACHE_TTL_IN_SECONDS: number` (default `300`), consumed by Task 6
  (`ApiKeyAuthGuard`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/env/src/apps/__tests__/core-server.environment.unit.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('coreServerENV.API_KEY_CACHE_TTL_IN_SECONDS', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    process.env.KAFKA_BOOTSTRAP_BROKERS = 'localhost:9092'
    process.env.DOCS_USERNAME = 'docs'
    process.env.DOCS_PASSWORD = 'docs'
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('defaults to 300 when unset', async () => {
    delete process.env.API_KEY_CACHE_TTL_IN_SECONDS
    const { coreServerENV } = await import('../core-server.environment.ts')

    expect(coreServerENV.API_KEY_CACHE_TTL_IN_SECONDS).toBe(300)
  })

  it('reads a positive integer override from the environment', async () => {
    process.env.API_KEY_CACHE_TTL_IN_SECONDS = '120'
    const { coreServerENV } = await import('../core-server.environment.ts')

    expect(coreServerENV.API_KEY_CACHE_TTL_IN_SECONDS).toBe(120)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ruguin/env test:unit -- core-server.environment.unit`
Expected: FAIL — `coreServerENV.API_KEY_CACHE_TTL_IN_SECONDS` is `undefined`, not `300`.

- [ ] **Step 3: Add the field**

```ts
// packages/env/src/apps/core-server.environment.ts
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

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
      API_KEY_CACHE_TTL_IN_SECONDS: z.coerce.number().int().positive().default(300)
    },
    extends: [serverENV, databaseENV, cacheENV, messageBrokerENV, docsENV],
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
```

- [ ] **Step 4: Run the test again**

Run: `pnpm --filter @ruguin/env test:unit -- core-server.environment.unit`
Expected: PASS

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @ruguin/env check:types`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/env/src/apps/core-server.environment.ts packages/env/src/apps/__tests__/core-server.environment.unit.ts
git commit -m "feat(env): add API_KEY_CACHE_TTL_IN_SECONDS to coreServerENV"
```

---

### Task 2: `BaseErrorExceptionFilter` — `StatusError` → HTTP mapping

**Files:**
- Create: `apps/core-server/src/shared/infrastructure/http/base-error-exception.filter.ts`
- Create: `apps/core-server/src/shared/infrastructure/http/__tests__/base-error-exception.filter.unit.ts`
- Modify: `apps/core-server/src/shared/infrastructure/bootstrap/configure-app.ts`
- Modify: `apps/core-server/src/shared/infrastructure/bootstrap/__tests__/configure-app.e2e.ts`

**Interfaces:**
- Consumes: `BaseError` (`@ruguin/shared-domain`) — `.status: StatusError`, `.message: string`,
  `.name: string`.
- Produces: `BaseErrorExceptionFilter`, registered globally by `configureApp()`. Every controller
  from Task 12 onward throws a `BaseError` subclass and relies on this filter for the HTTP response.

- [ ] **Step 1: Write the failing test**

```ts
// apps/core-server/src/shared/infrastructure/http/__tests__/base-error-exception.filter.unit.ts
import { type ArgumentsHost } from '@nestjs/common'
import { BaseError, StatusError } from '@ruguin/shared-domain'
import { describe, expect, it, vi } from 'vitest'

import { BaseErrorExceptionFilter } from '../base-error-exception.filter'

class FakeNotFoundError extends BaseError {
  readonly name = 'FakeNotFoundError'
  readonly status = StatusError.NOT_FOUND

  constructor() {
    super({ message: 'not found' })
  }
}

function createHost() {
  const send = vi.fn()
  const status = vi.fn(() => ({ send }))
  const reply = { status }
  const host = {
    switchToHttp: () => ({ getResponse: () => reply })
  } as unknown as ArgumentsHost

  return { host, status, send }
}

describe('BaseErrorExceptionFilter', () => {
  it.each([
    [StatusError.INVALID_INPUT, 400],
    [StatusError.UNAUTHORIZED, 401],
    [StatusError.FORBIDDEN, 403],
    [StatusError.NOT_FOUND, 404],
    [StatusError.CONFLICT, 409],
    [StatusError.UNPROCESSABLE, 422],
    [StatusError.TOO_MANY_REQUESTS, 429],
    [StatusError.INTERNAL_ERROR, 500]
  ])('maps StatusError.%s to HTTP %i', (statusError, httpStatus) => {
    class TestError extends BaseError {
      readonly name = 'TestError'
      readonly status = statusError

      constructor() {
        super({ message: 'boom' })
      }
    }

    const filter = new BaseErrorExceptionFilter()
    const { host, status } = createHost()

    filter.catch(new TestError(), host)

    expect(status).toHaveBeenCalledWith(httpStatus)
  })

  it('sends the error name and message in the response body', () => {
    const filter = new BaseErrorExceptionFilter()
    const { host, send } = createHost()

    filter.catch(new FakeNotFoundError(), host)

    expect(send).toHaveBeenCalledWith({ error: 'FakeNotFoundError', message: 'not found' })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ruguin/core-server test -- base-error-exception.filter.unit`
Expected: FAIL — `../base-error-exception.filter` does not exist.

- [ ] **Step 3: Implement the filter**

```ts
// apps/core-server/src/shared/infrastructure/http/base-error-exception.filter.ts
import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common'
import { BaseError, StatusError } from '@ruguin/shared-domain'
import { type FastifyReply } from 'fastify'

const STATUS_ERROR_TO_HTTP: Record<StatusError, number> = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500
}

@Catch(BaseError)
export class BaseErrorExceptionFilter implements ExceptionFilter {
  public catch(exception: BaseError, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>()
    const httpStatus = STATUS_ERROR_TO_HTTP[exception.status]

    reply.status(httpStatus).send({ error: exception.name, message: exception.message })
  }
}
```

- [ ] **Step 4: Run the test again**

Run: `pnpm --filter @ruguin/core-server test -- base-error-exception.filter.unit`
Expected: PASS

- [ ] **Step 5: Wire the filter into `configureApp`**

Modify `apps/core-server/src/shared/infrastructure/bootstrap/configure-app.ts` — add the import and
one line right after `app.enableVersioning(...)`:

```ts
import { BaseErrorExceptionFilter } from '../http/base-error-exception.filter'
```

```ts
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
  app.useGlobalFilters(new BaseErrorExceptionFilter())
```

- [ ] **Step 6: Add an e2e assertion that the filter is actually wired**

Rewrite `apps/core-server/src/shared/infrastructure/bootstrap/__tests__/configure-app.e2e.ts` to
register a throwaway controller (that throws a real `BaseError`) alongside `AppModule` in the test
module, so the assertion goes through Nest's real exception-filter pipeline instead of a raw
Fastify route that would bypass it entirely:

```ts
import { Controller, Get, type NestFastifyApplication } from '@nestjs/common'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { BaseError, StatusError } from '@ruguin/shared-domain'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../../../app.module'
import { configureApp } from '../configure-app'

vi.hoisted(() => {
  process.env.DOCS_USERNAME = 'test-docs-user'
  process.env.DOCS_PASSWORD = 'test-docs-pass'
  process.env.CACHE_PREFIX = 'ruguin:e2e'
  process.env.CACHE_DRIVER = 'memory'
})

class TestConflictError extends BaseError {
  readonly name = 'TestConflictError'
  readonly status = StatusError.CONFLICT

  constructor() {
    super({ message: 'test conflict' })
  }
}

@Controller('__test-base-error')
class ThrowingTestController {
  @Get()
  throwError(): never {
    throw new TestConflictError()
  }
}

function basicAuthHeader(username: string, password: string): string {
  const encoded = Buffer.from(`${username}:${password}`).toString('base64')
  return `Basic ${encoded}`
}

const VALID_CREDENTIALS = basicAuthHeader('test-docs-user', 'test-docs-pass')

describe('configureApp', () => {
  let app: NestFastifyApplication

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ThrowingTestController]
    }).compile()
    app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await configureApp(app)
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('maps a thrown BaseError to its StatusError-derived HTTP status via the global filter', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/__test-base-error' })

    expect(response.statusCode).toBe(409)
    expect(JSON.parse(response.body)).toEqual({ error: 'TestConflictError', message: 'test conflict' })
  })

  it('keeps /health version-neutral (no /v1 prefix)', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ status: 'ok' })
  })

  it('applies helmet security headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.headers['x-content-type-options']).toBe('nosniff')
  })

  it('rejects /docs without credentials', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs' })

    expect(response.statusCode).toBe(401)
  })

  it('serves /docs with correct credentials', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs',
      headers: { authorization: VALID_CREDENTIALS }
    })

    expect(response.statusCode).toBe(200)
  })

  it('rejects /docs-json without credentials', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs-json' })

    expect(response.statusCode).toBe(401)
  })

  it('serves the OpenAPI document at /docs-json with correct credentials', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs-json',
      headers: { authorization: VALID_CREDENTIALS }
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ openapi: expect.any(String) })
  })

  it.each([
    { credentials: basicAuthHeader('wrong-user', 'test-docs-pass'), label: 'wrong username' },
    { credentials: basicAuthHeader('test-docs-user', 'wrong-pass'), label: 'wrong password' }
  ])('rejects /docs with $label', async ({ credentials }) => {
    const response = await app.inject({ method: 'GET', url: '/docs', headers: { authorization: credentials } })

    expect(response.statusCode).toBe(401)
  })

  it.each([
    { credentials: basicAuthHeader('wrong-user', 'test-docs-pass'), label: 'wrong username' },
    { credentials: basicAuthHeader('test-docs-user', 'wrong-pass'), label: 'wrong password' }
  ])('rejects /docs-json with $label', async ({ credentials }) => {
    const response = await app.inject({ method: 'GET', url: '/docs-json', headers: { authorization: credentials } })

    expect(response.statusCode).toBe(401)
  })

  it.each(['/%64ocs', '/%64ocs-json'])('rejects the percent-encoded path %s without credentials', async (url) => {
    const response = await app.inject({ method: 'GET', url })

    expect(response.statusCode).toBe(401)
  })

  it.each(['/docs/', '/DOCS', '/docs-json/'])('never serves %s unauthenticated', async (url) => {
    const response = await app.inject({ method: 'GET', url })

    expect(response.statusCode).not.toBe(200)
  })
})
```

This is the full pre-existing suite (unchanged) plus the new `ThrowingTestController` and its
`maps a thrown BaseError...` case at the top — every other case is copied verbatim from the current
file so nothing already covered is lost.

- [ ] **Step 7: Run the e2e suite**

Run: `pnpm --filter @ruguin/core-server test:e2e -- configure-app.e2e`
Expected: PASS (needs `docker compose up -d` for Postgres/Valkey — the suite already requires that).

- [ ] **Step 8: Type-check and lint**

Run: `pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/core-server check:lint`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/core-server/src/shared/infrastructure/http apps/core-server/src/shared/infrastructure/bootstrap/configure-app.ts apps/core-server/src/shared/infrastructure/bootstrap/__tests__/configure-app.e2e.ts
git commit -m "feat(core-server): add BaseErrorExceptionFilter mapping StatusError to HTTP"
```

---

### Task 3: `organizations` module

**Files:**
- Create: `apps/core-server/prisma/schema/organization.prisma`
- Create: `apps/core-server/src/modules/organizations/domain/models/organization.model.ts`
- Create: `apps/core-server/src/modules/organizations/domain/models/__tests__/organization.model.unit.ts`
- Create: `apps/core-server/src/modules/organizations/domain/errors/invalid-organization.error.ts`
- Create: `apps/core-server/src/modules/organizations/domain/errors/find-organization.error.ts`
- Create: `apps/core-server/src/modules/organizations/domain/contracts/organization-lookup.provider.ts`
- Create: `apps/core-server/src/modules/organizations/infrastructure/database/prisma/organization.repository.ts`
- Create: `apps/core-server/src/modules/organizations/infrastructure/database/prisma/__tests__/organization.repository.unit.ts`
- Create: `apps/core-server/src/modules/organizations/organizations.module.ts`

**Interfaces:**
- Produces: `Organization` model (`id: ID`, `name: string`, `createdAt: Date`);
  `OrganizationLookupProvider.findById(input: { organizationId: string }): Promise<Either<FindOrganizationError, { organization: Organization | null }>>`;
  `ORGANIZATION_LOOKUP_PROVIDER` DI token; `OrganizationsModule` (exports `ORGANIZATION_LOOKUP_PROVIDER`).
  Nothing in this plan consumes `OrganizationLookupProvider` yet — it exists because the module owns
  the `organizations` table (design spec decision 1) and needs the same contract-first shape as
  every other module, ready for whenever a future module needs to read it.

- [ ] **Step 1: Write the failing test for `Organization.create`**

```ts
// apps/core-server/src/modules/organizations/domain/models/__tests__/organization.model.unit.ts
import { ID } from '@ruguin/shared-domain'
import { describe, expect, it } from 'vitest'

import { Organization } from '../organization.model'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Organization' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('Organization.create', () => {
  it('builds an Organization from valid input', () => {
    const id = validId()
    const createdAt = new Date('2026-08-04T00:00:00Z')

    const result = Organization.create({ id, name: 'Acme', createdAt })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.id).toBe(id)
      expect(result.value.name).toBe('Acme')
      expect(result.value.createdAt).toBe(createdAt)
    }
  })

  it('rejects an empty name', () => {
    const result = Organization.create({ id: validId(), name: '   ', createdAt: new Date() })

    expect(result.isFailure()).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ruguin/core-server test -- organization.model.unit`
Expected: FAIL — `../organization.model` does not exist.

- [ ] **Step 3: Implement `InvalidOrganizationError` and `Organization`**

```ts
// apps/core-server/src/modules/organizations/domain/errors/invalid-organization.error.ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class InvalidOrganizationError extends BaseError {
  readonly name = 'InvalidOrganizationError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { reason: string }) {
    super({ message: `Invalid organization: ${input.reason}.` })
  }
}
```

```ts
// apps/core-server/src/modules/organizations/domain/models/organization.model.ts
import { type ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidOrganizationError } from '../errors/invalid-organization.error'

export class Organization {
  private constructor(
    readonly id: ID,
    readonly name: string,
    readonly createdAt: Date
  ) {
    Object.freeze(this)
  }

  public static create(input: { id: ID; name: string; createdAt: Date }): Either<InvalidOrganizationError, Organization> {
    if (input.name.trim().length === 0) {
      return failure(new InvalidOrganizationError({ reason: 'name is empty' }))
    }

    return success(new Organization(input.id, input.name, input.createdAt))
  }
}
```

- [ ] **Step 4: Run the test again**

Run: `pnpm --filter @ruguin/core-server test -- organization.model.unit`
Expected: PASS

- [ ] **Step 5: Write the failing test for the Prisma repository**

```ts
// apps/core-server/src/modules/organizations/infrastructure/database/prisma/__tests__/organization.repository.unit.ts
import { describe, expect, it } from 'vitest'

import { OrganizationRepository } from '../organization.repository'

function createPrismaStub(row: { id: string; name: string; createdAt: Date } | null) {
  return { organization: { findUnique: async () => row } } as unknown as ConstructorParameters<typeof OrganizationRepository>[0]
}

describe('OrganizationRepository#findById', () => {
  it('maps a found row into an Organization', async () => {
    const repository = new OrganizationRepository(
      createPrismaStub({ id: '0198f3b2-1234-7000-8000-000000000001', name: 'Acme', createdAt: new Date('2026-01-01') })
    )

    const result = await repository.findById({ organizationId: '0198f3b2-1234-7000-8000-000000000001' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.organization?.name).toBe('Acme')
    }
  })

  it('returns { organization: null } when the row does not exist', async () => {
    const repository = new OrganizationRepository(createPrismaStub(null))

    const result = await repository.findById({ organizationId: '0198f3b2-1234-7000-8000-000000000002' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.organization).toBeNull()
    }
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @ruguin/core-server test -- organization.repository.unit`
Expected: FAIL — `../organization.repository` does not exist.

- [ ] **Step 7: Write the Prisma schema**

```prisma
// apps/core-server/prisma/schema/organization.prisma
model Organization {
  id        String   @id @default(uuid(7))
  name      String
  createdAt DateTime @default(now())

  @@map("organizations")
}
```

- [ ] **Step 8: Start Postgres and create the migration**

Run: `docker compose up -d` (from repo root, if not already running)
Run: `pnpm with-env pnpm --filter @ruguin/core-server db:migrate` — name it `add_organizations`
when prompted.
Run: `pnpm --filter @ruguin/core-server db:generate`

- [ ] **Step 9: Implement `FindOrganizationError`, `OrganizationLookupProvider`, and `OrganizationRepository`**

```ts
// apps/core-server/src/modules/organizations/domain/errors/find-organization.error.ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class FindOrganizationError extends BaseError {
  readonly name = 'FindOrganizationError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to look up the organization.' })
  }
}
```

```ts
// apps/core-server/src/modules/organizations/domain/contracts/organization-lookup.provider.ts
import { type Either } from '@ruguin/utils'

import { type FindOrganizationError } from '../errors/find-organization.error'
import { type Organization } from '../models/organization.model'

export const ORGANIZATION_LOOKUP_PROVIDER = Symbol('ORGANIZATION_LOOKUP_PROVIDER')

export interface OrganizationLookupProvider {
  findById(input: { organizationId: string }): Promise<Either<FindOrganizationError, { organization: Organization | null }>>
}
```

```ts
// apps/core-server/src/modules/organizations/infrastructure/database/prisma/organization.repository.ts
import { Injectable } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { type OrganizationLookupProvider } from '../../../domain/contracts/organization-lookup.provider'
import { FindOrganizationError } from '../../../domain/errors/find-organization.error'
import { InvalidOrganizationError } from '../../../domain/errors/invalid-organization.error'
import { Organization } from '../../../domain/models/organization.model'

import { PrismaService } from '../../../../../shared/infrastructure/database/prisma/prisma.service'

@Injectable()
export class OrganizationRepository implements OrganizationLookupProvider {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(row: { id: string; name: string; createdAt: Date }): Either<InvalidOrganizationError, Organization> {
    const idResult = ID.validate({ id: row.id, modelName: 'Organization' })
    if (idResult.isFailure()) return failure(new InvalidOrganizationError({ reason: idResult.value.message }))

    return Organization.create({ id: idResult.value.idValidated, name: row.name, createdAt: row.createdAt })
  }

  public async findById(input: {
    organizationId: string
  }): Promise<Either<FindOrganizationError, { organization: Organization | null }>> {
    try {
      const row = await this.prisma.organization.findUnique({ where: { id: input.organizationId } })
      if (row === null) return success({ organization: null })

      const mapped = this.toDomain(row)
      if (mapped.isFailure()) return failure(new FindOrganizationError({ error: mapped.value }))

      return success({ organization: mapped.value })
    } catch (error: unknown) {
      return failure(new FindOrganizationError({ error }))
    }
  }
}
```

- [ ] **Step 10: Run the repository test again**

Run: `pnpm --filter @ruguin/core-server test -- organization.repository.unit`
Expected: PASS

- [ ] **Step 11: Implement `OrganizationsModule`**

```ts
// apps/core-server/src/modules/organizations/organizations.module.ts
import { Module } from '@nestjs/common'

import { ORGANIZATION_LOOKUP_PROVIDER } from './domain/contracts/organization-lookup.provider'
import { OrganizationRepository } from './infrastructure/database/prisma/organization.repository'

@Module({
  providers: [OrganizationRepository, { provide: ORGANIZATION_LOOKUP_PROVIDER, useExisting: OrganizationRepository }],
  exports: [ORGANIZATION_LOOKUP_PROVIDER]
})
export class OrganizationsModule {}
```

- [ ] **Step 12: Type-check and lint**

Run: `pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/core-server check:lint`
Expected: no errors.

- [ ] **Step 13: Commit**

```bash
git add apps/core-server/prisma/schema/organization.prisma apps/core-server/prisma/migrations apps/core-server/src/modules/organizations
git commit -m "feat(core-server): add organizations module (data + lookup provider)"
```

---

### Task 4: `projects` module

**Files:**
- Create: `apps/core-server/prisma/schema/project.prisma`
- Create: `apps/core-server/src/modules/projects/domain/models/project.model.ts`
- Create: `apps/core-server/src/modules/projects/domain/models/__tests__/project.model.unit.ts`
- Create: `apps/core-server/src/modules/projects/domain/errors/invalid-project.error.ts`
- Create: `apps/core-server/src/modules/projects/domain/errors/find-project.error.ts`
- Create: `apps/core-server/src/modules/projects/domain/contracts/project-lookup.provider.ts`
- Create: `apps/core-server/src/modules/projects/infrastructure/database/prisma/project.repository.ts`
- Create: `apps/core-server/src/modules/projects/infrastructure/database/prisma/__tests__/project.repository.unit.ts`
- Create: `apps/core-server/src/modules/projects/projects.module.ts`

**Interfaces:**
- Produces: `Project` model (`id: ID`, `organizationId: string`, `name: string`, `createdAt: Date`);
  `ProjectLookupProvider.findById(input: { projectId: string }): Promise<Either<FindProjectError, { project: Project | null }>>`;
  `PROJECT_LOOKUP_PROVIDER` DI token; `ProjectsModule` (exports `PROJECT_LOOKUP_PROVIDER`). Consumed
  by Task 6 (`ApiKeyAuthGuard`, to resolve `organizationId` from the API key's `projectId`).

Mirrors Task 3 exactly, one field added (`organizationId`). Follow the same nine implementation
steps with these bodies:

- [ ] **Step 1: Write the failing test for `Project.create`**

```ts
// apps/core-server/src/modules/projects/domain/models/__tests__/project.model.unit.ts
import { ID } from '@ruguin/shared-domain'
import { describe, expect, it } from 'vitest'

import { Project } from '../project.model'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Project' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('Project.create', () => {
  it('builds a Project from valid input', () => {
    const id = validId()
    const createdAt = new Date('2026-08-04T00:00:00Z')

    const result = Project.create({ id, organizationId: 'org-1', name: 'Prod', createdAt })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.organizationId).toBe('org-1')
      expect(result.value.name).toBe('Prod')
    }
  })

  it('rejects an empty name', () => {
    const result = Project.create({ id: validId(), organizationId: 'org-1', name: '', createdAt: new Date() })

    expect(result.isFailure()).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails.** Same command shape as Task 3, target `project.model.unit`.

- [ ] **Step 3: Implement `InvalidProjectError` and `Project`**

```ts
// apps/core-server/src/modules/projects/domain/errors/invalid-project.error.ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class InvalidProjectError extends BaseError {
  readonly name = 'InvalidProjectError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { reason: string }) {
    super({ message: `Invalid project: ${input.reason}.` })
  }
}
```

```ts
// apps/core-server/src/modules/projects/domain/models/project.model.ts
import { type ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidProjectError } from '../errors/invalid-project.error'

export class Project {
  private constructor(
    readonly id: ID,
    readonly organizationId: string,
    readonly name: string,
    readonly createdAt: Date
  ) {
    Object.freeze(this)
  }

  public static create(input: {
    id: ID
    organizationId: string
    name: string
    createdAt: Date
  }): Either<InvalidProjectError, Project> {
    if (input.name.trim().length === 0) return failure(new InvalidProjectError({ reason: 'name is empty' }))
    if (input.organizationId.trim().length === 0) {
      return failure(new InvalidProjectError({ reason: 'organizationId is empty' }))
    }

    return success(new Project(input.id, input.organizationId, input.name, input.createdAt))
  }
}
```

- [ ] **Step 4: Run the test again.** Expected PASS.

- [ ] **Step 5: Write the failing repository test**

```ts
// apps/core-server/src/modules/projects/infrastructure/database/prisma/__tests__/project.repository.unit.ts
import { describe, expect, it } from 'vitest'

import { ProjectRepository } from '../project.repository'

function createPrismaStub(row: { id: string; organizationId: string; name: string; createdAt: Date } | null) {
  return { project: { findUnique: async () => row } } as unknown as ConstructorParameters<typeof ProjectRepository>[0]
}

describe('ProjectRepository#findById', () => {
  it('maps a found row into a Project', async () => {
    const repository = new ProjectRepository(
      createPrismaStub({
        id: '0198f3b2-1234-7000-8000-000000000010',
        organizationId: '0198f3b2-1234-7000-8000-000000000001',
        name: 'Prod',
        createdAt: new Date('2026-01-01')
      })
    )

    const result = await repository.findById({ projectId: '0198f3b2-1234-7000-8000-000000000010' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.project?.organizationId).toBe('0198f3b2-1234-7000-8000-000000000001')
    }
  })

  it('returns { project: null } when the row does not exist', async () => {
    const repository = new ProjectRepository(createPrismaStub(null))

    const result = await repository.findById({ projectId: 'missing' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.project).toBeNull()
  })
})
```

- [ ] **Step 6: Run it to verify it fails.**

- [ ] **Step 7: Write the Prisma schema**

```prisma
// apps/core-server/prisma/schema/project.prisma
model Project {
  id             String   @id @default(uuid(7))
  organizationId String
  name           String
  createdAt      DateTime @default(now())

  @@index([organizationId])
  @@map("projects")
}
```

- [ ] **Step 8: Create the migration**

Run: `pnpm with-env pnpm --filter @ruguin/core-server db:migrate` — name it `add_projects`.
Run: `pnpm --filter @ruguin/core-server db:generate`

- [ ] **Step 9: Implement `FindProjectError`, `ProjectLookupProvider`, `ProjectRepository`**

```ts
// apps/core-server/src/modules/projects/domain/errors/find-project.error.ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class FindProjectError extends BaseError {
  readonly name = 'FindProjectError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to look up the project.' })
  }
}
```

```ts
// apps/core-server/src/modules/projects/domain/contracts/project-lookup.provider.ts
import { type Either } from '@ruguin/utils'

import { type FindProjectError } from '../errors/find-project.error'
import { type Project } from '../models/project.model'

export const PROJECT_LOOKUP_PROVIDER = Symbol('PROJECT_LOOKUP_PROVIDER')

export interface ProjectLookupProvider {
  findById(input: { projectId: string }): Promise<Either<FindProjectError, { project: Project | null }>>
}
```

```ts
// apps/core-server/src/modules/projects/infrastructure/database/prisma/project.repository.ts
import { Injectable } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { type ProjectLookupProvider } from '../../../domain/contracts/project-lookup.provider'
import { FindProjectError } from '../../../domain/errors/find-project.error'
import { InvalidProjectError } from '../../../domain/errors/invalid-project.error'
import { Project } from '../../../domain/models/project.model'

import { PrismaService } from '../../../../../shared/infrastructure/database/prisma/prisma.service'

@Injectable()
export class ProjectRepository implements ProjectLookupProvider {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(row: {
    id: string
    organizationId: string
    name: string
    createdAt: Date
  }): Either<InvalidProjectError, Project> {
    const idResult = ID.validate({ id: row.id, modelName: 'Project' })
    if (idResult.isFailure()) return failure(new InvalidProjectError({ reason: idResult.value.message }))

    return Project.create({
      id: idResult.value.idValidated,
      organizationId: row.organizationId,
      name: row.name,
      createdAt: row.createdAt
    })
  }

  public async findById(input: { projectId: string }): Promise<Either<FindProjectError, { project: Project | null }>> {
    try {
      const row = await this.prisma.project.findUnique({ where: { id: input.projectId } })
      if (row === null) return success({ project: null })

      const mapped = this.toDomain(row)
      if (mapped.isFailure()) return failure(new FindProjectError({ error: mapped.value }))

      return success({ project: mapped.value })
    } catch (error: unknown) {
      return failure(new FindProjectError({ error }))
    }
  }
}
```

- [ ] **Step 10: Run the repository test again.** Expected PASS.

- [ ] **Step 11: Implement `ProjectsModule`**

```ts
// apps/core-server/src/modules/projects/projects.module.ts
import { Module } from '@nestjs/common'

import { PROJECT_LOOKUP_PROVIDER } from './domain/contracts/project-lookup.provider'
import { ProjectRepository } from './infrastructure/database/prisma/project.repository'

@Module({
  providers: [ProjectRepository, { provide: PROJECT_LOOKUP_PROVIDER, useExisting: ProjectRepository }],
  exports: [PROJECT_LOOKUP_PROVIDER]
})
export class ProjectsModule {}
```

- [ ] **Step 12: Type-check and lint.**

- [ ] **Step 13: Commit**

```bash
git add apps/core-server/prisma/schema/project.prisma apps/core-server/prisma/migrations apps/core-server/src/modules/projects
git commit -m "feat(core-server): add projects module (data + lookup provider)"
```

---

### Task 5: `templates` module (data layer)

**Files:**
- Create: `apps/core-server/prisma/schema/template.prisma`
- Create: `apps/core-server/src/modules/templates/domain/models/template.model.ts`
- Create: `apps/core-server/src/modules/templates/domain/models/__tests__/template.model.unit.ts`
- Create: `apps/core-server/src/modules/templates/domain/errors/invalid-template.error.ts`
- Create: `apps/core-server/src/modules/templates/domain/errors/find-template.error.ts`
- Create: `apps/core-server/src/modules/templates/domain/contracts/template-lookup.provider.ts`
- Create: `apps/core-server/src/modules/templates/infrastructure/database/prisma/template.repository.ts`
- Create: `apps/core-server/src/modules/templates/infrastructure/database/prisma/__tests__/template.repository.unit.ts`
- Create: `apps/core-server/src/modules/templates/templates.module.ts`

**Interfaces:**
- Produces: `Template` model (`id: ID`, `projectId: string`, `name: string`, `subject: string`,
  `html: string`, `createdAt: Date`);
  `TemplateLookupProvider.findByIdAndProjectId(input: { templateId: string; projectId: string }): Promise<Either<FindTemplateError, { template: Template | null }>>`
  — scoped by `projectId` so a template from another tenant is invisible, never a `404` mapped from
  a leaked row; `TEMPLATE_LOOKUP_PROVIDER` DI token; `TemplatesModule`. Consumed by Task 11
  (`SendEmailUseCase`).

- [ ] **Step 1: Write the failing test for `Template.create`**

```ts
// apps/core-server/src/modules/templates/domain/models/__tests__/template.model.unit.ts
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
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '<p>Hi {{name}}</p>',
      createdAt: new Date('2026-08-04T00:00:00Z')
    })

    expect(result.isSuccess()).toBe(true)
  })

  it('rejects an empty subject', () => {
    const result = Template.create({
      id: validId(),
      projectId: 'project-1',
      name: 'Welcome',
      subject: '',
      html: '<p>hi</p>',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement `InvalidTemplateError` and `Template`**

```ts
// apps/core-server/src/modules/templates/domain/errors/invalid-template.error.ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class InvalidTemplateError extends BaseError {
  readonly name = 'InvalidTemplateError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { reason: string }) {
    super({ message: `Invalid template: ${input.reason}.` })
  }
}
```

```ts
// apps/core-server/src/modules/templates/domain/models/template.model.ts
import { type ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidTemplateError } from '../errors/invalid-template.error'

export class Template {
  private constructor(
    readonly id: ID,
    readonly projectId: string,
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
    name: string
    subject: string
    html: string
    createdAt: Date
  }): Either<InvalidTemplateError, Template> {
    if (input.subject.trim().length === 0) return failure(new InvalidTemplateError({ reason: 'subject is empty' }))
    if (input.html.trim().length === 0) return failure(new InvalidTemplateError({ reason: 'html is empty' }))

    return success(new Template(input.id, input.projectId, input.name, input.subject, input.html, input.createdAt))
  }
}
```

- [ ] **Step 4: Run the test again.** Expected PASS.

- [ ] **Step 5: Write the failing repository test**

```ts
// apps/core-server/src/modules/templates/infrastructure/database/prisma/__tests__/template.repository.unit.ts
import { describe, expect, it } from 'vitest'

import { TemplateRepository } from '../template.repository'

function createPrismaStub(
  row: { id: string; projectId: string; name: string; subject: string; html: string; createdAt: Date } | null
) {
  return { template: { findFirst: async () => row } } as unknown as ConstructorParameters<typeof TemplateRepository>[0]
}

describe('TemplateRepository#findByIdAndProjectId', () => {
  it('maps a found row scoped to the project', async () => {
    const repository = new TemplateRepository(
      createPrismaStub({
        id: '0198f3b2-1234-7000-8000-000000000020',
        projectId: 'project-1',
        name: 'Welcome',
        subject: 'Hi {{name}}',
        html: '<p>Hi {{name}}</p>',
        createdAt: new Date('2026-01-01')
      })
    )

    const result = await repository.findByIdAndProjectId({
      templateId: '0198f3b2-1234-7000-8000-000000000020',
      projectId: 'project-1'
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.template?.subject).toBe('Hi {{name}}')
  })

  it('returns { template: null } for a template owned by another project', async () => {
    const repository = new TemplateRepository(createPrismaStub(null))

    const result = await repository.findByIdAndProjectId({ templateId: 'other-projects-template', projectId: 'project-1' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.template).toBeNull()
  })
})
```

- [ ] **Step 6: Run it to verify it fails.**

- [ ] **Step 7: Write the Prisma schema**

```prisma
// apps/core-server/prisma/schema/template.prisma
model Template {
  id        String   @id @default(uuid(7))
  projectId String
  name      String
  subject   String
  html      String
  createdAt DateTime @default(now())

  @@index([projectId])
  @@map("templates")
}
```

- [ ] **Step 8: Create the migration**

Run: `pnpm with-env pnpm --filter @ruguin/core-server db:migrate` — name it `add_templates`.
Run: `pnpm --filter @ruguin/core-server db:generate`

- [ ] **Step 9: Implement `FindTemplateError`, `TemplateLookupProvider`, `TemplateRepository`**

```ts
// apps/core-server/src/modules/templates/domain/errors/find-template.error.ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class FindTemplateError extends BaseError {
  readonly name = 'FindTemplateError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to look up the template.' })
  }
}
```

```ts
// apps/core-server/src/modules/templates/domain/contracts/template-lookup.provider.ts
import { type Either } from '@ruguin/utils'

import { type FindTemplateError } from '../errors/find-template.error'
import { type Template } from '../models/template.model'

export const TEMPLATE_LOOKUP_PROVIDER = Symbol('TEMPLATE_LOOKUP_PROVIDER')

export interface TemplateLookupProvider {
  findByIdAndProjectId(input: {
    templateId: string
    projectId: string
  }): Promise<Either<FindTemplateError, { template: Template | null }>>
}
```

```ts
// apps/core-server/src/modules/templates/infrastructure/database/prisma/template.repository.ts
import { Injectable } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { type TemplateLookupProvider } from '../../../domain/contracts/template-lookup.provider'
import { FindTemplateError } from '../../../domain/errors/find-template.error'
import { InvalidTemplateError } from '../../../domain/errors/invalid-template.error'
import { Template } from '../../../domain/models/template.model'

import { PrismaService } from '../../../../../shared/infrastructure/database/prisma/prisma.service'

@Injectable()
export class TemplateRepository implements TemplateLookupProvider {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(row: {
    id: string
    projectId: string
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
      // Scoped by BOTH columns in the query itself — never fetched by id alone and filtered after,
      // which would make the isolation check a runtime `if` instead of a query-shape guarantee.
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

- [ ] **Step 10: Run the repository test again.** Expected PASS.

- [ ] **Step 11: Implement `TemplatesModule`**

```ts
// apps/core-server/src/modules/templates/templates.module.ts
import { Module } from '@nestjs/common'

import { TEMPLATE_LOOKUP_PROVIDER } from './domain/contracts/template-lookup.provider'
import { TemplateRepository } from './infrastructure/database/prisma/template.repository'

@Module({
  providers: [TemplateRepository, { provide: TEMPLATE_LOOKUP_PROVIDER, useExisting: TemplateRepository }],
  exports: [TEMPLATE_LOOKUP_PROVIDER]
})
export class TemplatesModule {}
```

- [ ] **Step 12: Type-check and lint.**

- [ ] **Step 13: Commit**

```bash
git add apps/core-server/prisma/schema/template.prisma apps/core-server/prisma/migrations apps/core-server/src/modules/templates
git commit -m "feat(core-server): add templates module (data + lookup provider)"
```

---

### Task 6: Template rendering — `{{variable}}` substitution

**Files:**
- Create: `apps/core-server/src/modules/templates/domain/render-template.ts`
- Create: `apps/core-server/src/modules/templates/domain/__tests__/render-template.unit.ts`
- Create: `apps/core-server/src/modules/templates/domain/errors/missing-template-variable.error.ts`

**Interfaces:**
- Produces: `renderTemplate(input: { subject: string; html: string; variables: Record<string, string> }): Either<MissingTemplateVariableError, { subject: string; html: string }>`.
  Consumed by Task 11 (`SendEmailUseCase`).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/core-server/src/modules/templates/domain/__tests__/render-template.unit.ts
import { describe, expect, it } from 'vitest'

import { renderTemplate } from '../render-template'

describe('renderTemplate', () => {
  it('substitutes every {{variable}} occurrence in subject and html', () => {
    const result = renderTemplate({
      subject: 'Hi {{name}}',
      html: '<p>Welcome, {{name}}! Your plan is {{plan}}.</p>',
      variables: { name: 'Ada', plan: 'Pro' }
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.subject).toBe('Hi Ada')
      expect(result.value.html).toBe('<p>Welcome, Ada! Your plan is Pro.</p>')
    }
  })

  it('fails explicitly when a referenced variable is missing, never emitting the literal placeholder', () => {
    const result = renderTemplate({ subject: 'Hi {{name}}', html: '<p>ok</p>', variables: {} })

    expect(result.isFailure()).toBe(true)
  })

  it('is a no-op when the template has no placeholders', () => {
    const result = renderTemplate({ subject: 'Hello', html: '<p>Hello</p>', variables: {} })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value).toEqual({ subject: 'Hello', html: '<p>Hello</p>' })
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ruguin/core-server test -- render-template.unit`
Expected: FAIL — `../render-template` does not exist.

- [ ] **Step 3: Implement `MissingTemplateVariableError` and `renderTemplate`**

```ts
// apps/core-server/src/modules/templates/domain/errors/missing-template-variable.error.ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class MissingTemplateVariableError extends BaseError {
  readonly name = 'MissingTemplateVariableError'
  readonly status = StatusError.UNPROCESSABLE

  constructor(input: { variableName: string }) {
    super({ message: `Template references "{{${input.variableName}}}", which was not provided.` })
  }
}
```

```ts
// apps/core-server/src/modules/templates/domain/render-template.ts
import { type Either, failure, success } from '@ruguin/utils'

import { MissingTemplateVariableError } from './errors/missing-template-variable.error'

const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g

function substitute(text: string, variables: Record<string, string>): Either<MissingTemplateVariableError, string> {
  let missingVariableName: string | undefined

  const replaced = text.replaceAll(VARIABLE_PATTERN, (_match, variableName: string) => {
    // Once one variable is known missing, stop substituting — the placeholder itself is
    // irrelevant, this branch only exists to short-circuit the remaining replacements cheaply.
    if (missingVariableName !== undefined) return ''

    const value = variables[variableName]
    if (value === undefined) {
      missingVariableName = variableName
      return ''
    }

    return value
  })

  if (missingVariableName !== undefined) {
    return failure(new MissingTemplateVariableError({ variableName: missingVariableName }))
  }

  return success(replaced)
}

export function renderTemplate(input: {
  subject: string
  html: string
  variables: Record<string, string>
}): Either<MissingTemplateVariableError, { subject: string; html: string }> {
  const subjectResult = substitute(input.subject, input.variables)
  if (subjectResult.isFailure()) return subjectResult

  const htmlResult = substitute(input.html, input.variables)
  if (htmlResult.isFailure()) return htmlResult

  return success({ subject: subjectResult.value, html: htmlResult.value })
}
```

- [ ] **Step 4: Run the tests again**

Run: `pnpm --filter @ruguin/core-server test -- render-template.unit`
Expected: PASS

- [ ] **Step 5: Type-check and lint.**

- [ ] **Step 6: Commit**

```bash
git add apps/core-server/src/modules/templates/domain/render-template.ts apps/core-server/src/modules/templates/domain/errors/missing-template-variable.error.ts apps/core-server/src/modules/templates/domain/__tests__/render-template.unit.ts
git commit -m "feat(core-server): add pure {{variable}} template renderer"
```

---

### Task 7: `api-keys` module — data layer and hashing

**Files:**
- Create: `apps/core-server/prisma/schema/api-key.prisma`
- Create: `apps/core-server/src/modules/api-keys/domain/hash-api-key.ts`
- Create: `apps/core-server/src/modules/api-keys/domain/__tests__/hash-api-key.unit.ts`
- Create: `apps/core-server/src/modules/api-keys/domain/models/api-key.model.ts`
- Create: `apps/core-server/src/modules/api-keys/domain/models/__tests__/api-key.model.unit.ts`
- Create: `apps/core-server/src/modules/api-keys/domain/errors/invalid-api-key.error.ts`
- Create: `apps/core-server/src/modules/api-keys/domain/errors/find-api-key.error.ts`
- Create: `apps/core-server/src/modules/api-keys/domain/contracts/api-key.repository.ts`
- Create: `apps/core-server/src/modules/api-keys/infrastructure/database/prisma/api-key.repository.ts`
- Create: `apps/core-server/src/modules/api-keys/infrastructure/database/prisma/__tests__/api-key.repository.unit.ts`

**Interfaces:**
- Produces: `hashApiKey(input: { rawKey: string }): string`; `ApiKey` model (`id: ID`,
  `projectId: string`, `hashedKey: string`, `revokedAt: Date | null`, `createdAt: Date`);
  `ApiKeyRepository.findActiveByHashedKey(input: { hashedKey: string }): Promise<Either<FindApiKeyError, { apiKey: ApiKey | null }>>`
  — only returns a row when `revokedAt IS NULL`; `API_KEY_REPOSITORY` DI token. Consumed by Task 8
  (`ApiKeyAuthGuard`).

- [ ] **Step 1: Write the failing test for `hashApiKey`**

```ts
// apps/core-server/src/modules/api-keys/domain/__tests__/hash-api-key.unit.ts
import { describe, expect, it } from 'vitest'

import { hashApiKey } from '../hash-api-key'

describe('hashApiKey', () => {
  it('is deterministic for the same input', () => {
    expect(hashApiKey({ rawKey: 'sk-test-123' })).toBe(hashApiKey({ rawKey: 'sk-test-123' }))
  })

  it('produces a 64-character lowercase hex digest (SHA-256)', () => {
    const hashed = hashApiKey({ rawKey: 'sk-test-123' })

    expect(hashed).toMatch(/^[0-9a-f]{64}$/)
  })

  it('differs for different inputs', () => {
    expect(hashApiKey({ rawKey: 'sk-a' })).not.toBe(hashApiKey({ rawKey: 'sk-b' }))
  })
})
```

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement `hashApiKey`**

```ts
// apps/core-server/src/modules/api-keys/domain/hash-api-key.ts
import { createHash } from 'node:crypto'

/*
 * SHA-256, not bcrypt: the input is already a high-entropy, randomly generated token (see
 * prisma/seed.ts), not a human-chosen password. Brute-forcing the key space is infeasible
 * regardless of hash speed, so a slow KDF would only add latency to every authenticated request
 * without a matching security gain.
 */
export function hashApiKey(input: { rawKey: string }): string {
  return createHash('sha256').update(input.rawKey).digest('hex')
}
```

- [ ] **Step 4: Run the test again.** Expected PASS.

- [ ] **Step 5: Write the failing test for `ApiKey.create`**

```ts
// apps/core-server/src/modules/api-keys/domain/models/__tests__/api-key.model.unit.ts
import { ID } from '@ruguin/shared-domain'
import { describe, expect, it } from 'vitest'

import { ApiKey } from '../api-key.model'

function validId(): ID {
  const generated = ID.generate({ modelName: 'ApiKey' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('ApiKey.create', () => {
  it('builds an active ApiKey when revokedAt is null', () => {
    const result = ApiKey.create({
      id: validId(),
      projectId: 'project-1',
      hashedKey: 'a'.repeat(64),
      revokedAt: null,
      createdAt: new Date()
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.isRevoked()).toBe(false)
  })

  it('reports isRevoked() true when revokedAt is set', () => {
    const result = ApiKey.create({
      id: validId(),
      projectId: 'project-1',
      hashedKey: 'a'.repeat(64),
      revokedAt: new Date(),
      createdAt: new Date()
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.isRevoked()).toBe(true)
  })

  it('rejects an empty hashedKey', () => {
    const result = ApiKey.create({ id: validId(), projectId: 'project-1', hashedKey: '', revokedAt: null, createdAt: new Date() })

    expect(result.isFailure()).toBe(true)
  })
})
```

- [ ] **Step 6: Run it to verify it fails.**

- [ ] **Step 7: Implement `InvalidApiKeyError` and `ApiKey`**

```ts
// apps/core-server/src/modules/api-keys/domain/errors/invalid-api-key.error.ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class InvalidApiKeyError extends BaseError {
  readonly name = 'InvalidApiKeyError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { reason: string }) {
    super({ message: `Invalid API key record: ${input.reason}.` })
  }
}
```

```ts
// apps/core-server/src/modules/api-keys/domain/models/api-key.model.ts
import { type ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidApiKeyError } from '../errors/invalid-api-key.error'

export class ApiKey {
  private constructor(
    readonly id: ID,
    readonly projectId: string,
    readonly hashedKey: string,
    readonly revokedAt: Date | null,
    readonly createdAt: Date
  ) {
    Object.freeze(this)
  }

  public static create(input: {
    id: ID
    projectId: string
    hashedKey: string
    revokedAt: Date | null
    createdAt: Date
  }): Either<InvalidApiKeyError, ApiKey> {
    if (input.hashedKey.trim().length === 0) return failure(new InvalidApiKeyError({ reason: 'hashedKey is empty' }))
    if (input.projectId.trim().length === 0) return failure(new InvalidApiKeyError({ reason: 'projectId is empty' }))

    return success(new ApiKey(input.id, input.projectId, input.hashedKey, input.revokedAt, input.createdAt))
  }

  public isRevoked(): boolean {
    return this.revokedAt !== null
  }
}
```

- [ ] **Step 8: Run the test again.** Expected PASS.

- [ ] **Step 9: Write the failing repository test**

```ts
// apps/core-server/src/modules/api-keys/infrastructure/database/prisma/__tests__/api-key.repository.unit.ts
import { describe, expect, it } from 'vitest'

import { ApiKeyRepository } from '../api-key.repository'

function createPrismaStub(
  row: { id: string; projectId: string; hashedKey: string; revokedAt: Date | null; createdAt: Date } | null
) {
  return { apiKey: { findFirst: async () => row } } as unknown as ConstructorParameters<typeof ApiKeyRepository>[0]
}

describe('ApiKeyRepository#findActiveByHashedKey', () => {
  it('maps a found, active row into an ApiKey', async () => {
    const repository = new ApiKeyRepository(
      createPrismaStub({
        id: '0198f3b2-1234-7000-8000-000000000030',
        projectId: 'project-1',
        hashedKey: 'a'.repeat(64),
        revokedAt: null,
        createdAt: new Date('2026-01-01')
      })
    )

    const result = await repository.findActiveByHashedKey({ hashedKey: 'a'.repeat(64) })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.apiKey?.projectId).toBe('project-1')
  })

  it('returns { apiKey: null } when no active row matches (unknown or revoked key)', async () => {
    const repository = new ApiKeyRepository(createPrismaStub(null))

    const result = await repository.findActiveByHashedKey({ hashedKey: 'b'.repeat(64) })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.apiKey).toBeNull()
  })
})
```

- [ ] **Step 10: Run it to verify it fails.**

- [ ] **Step 11: Write the Prisma schema**

```prisma
// apps/core-server/prisma/schema/api-key.prisma
model ApiKey {
  id        String    @id @default(uuid(7))
  projectId String
  hashedKey String    @unique
  revokedAt DateTime?
  createdAt DateTime  @default(now())

  @@index([projectId])
  @@map("api_keys")
}
```

- [ ] **Step 12: Create the migration**

Run: `pnpm with-env pnpm --filter @ruguin/core-server db:migrate` — name it `add_api_keys`.
Run: `pnpm --filter @ruguin/core-server db:generate`

- [ ] **Step 13: Implement `FindApiKeyError`, the `ApiKeyRepository` contract, and its Prisma adapter**

```ts
// apps/core-server/src/modules/api-keys/domain/errors/find-api-key.error.ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class FindApiKeyError extends BaseError {
  readonly name = 'FindApiKeyError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to look up the API key.' })
  }
}
```

```ts
// apps/core-server/src/modules/api-keys/domain/contracts/api-key.repository.ts
import { type Either } from '@ruguin/utils'

import { type FindApiKeyError } from '../errors/find-api-key.error'
import { type ApiKey } from '../models/api-key.model'

export const API_KEY_REPOSITORY = Symbol('API_KEY_REPOSITORY')

export interface ApiKeyRepository {
  findActiveByHashedKey(input: { hashedKey: string }): Promise<Either<FindApiKeyError, { apiKey: ApiKey | null }>>
}
```

```ts
// apps/core-server/src/modules/api-keys/infrastructure/database/prisma/api-key.repository.ts
import { Injectable } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { type ApiKeyRepository as ApiKeyRepositoryContract } from '../../../domain/contracts/api-key.repository'
import { FindApiKeyError } from '../../../domain/errors/find-api-key.error'
import { InvalidApiKeyError } from '../../../domain/errors/invalid-api-key.error'
import { ApiKey } from '../../../domain/models/api-key.model'

import { PrismaService } from '../../../../../shared/infrastructure/database/prisma/prisma.service'

@Injectable()
export class ApiKeyRepository implements ApiKeyRepositoryContract {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(row: {
    id: string
    projectId: string
    hashedKey: string
    revokedAt: Date | null
    createdAt: Date
  }): Either<InvalidApiKeyError, ApiKey> {
    const idResult = ID.validate({ id: row.id, modelName: 'ApiKey' })
    if (idResult.isFailure()) return failure(new InvalidApiKeyError({ reason: idResult.value.message }))

    return ApiKey.create({
      id: idResult.value.idValidated,
      projectId: row.projectId,
      hashedKey: row.hashedKey,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt
    })
  }

  public async findActiveByHashedKey(input: {
    hashedKey: string
  }): Promise<Either<FindApiKeyError, { apiKey: ApiKey | null }>> {
    try {
      // revokedAt filtered in the query itself: a revoked key must never even reach toDomain,
      // let alone be handed back as "found".
      const row = await this.prisma.apiKey.findFirst({ where: { hashedKey: input.hashedKey, revokedAt: null } })
      if (row === null) return success({ apiKey: null })

      const mapped = this.toDomain(row)
      if (mapped.isFailure()) return failure(new FindApiKeyError({ error: mapped.value }))

      return success({ apiKey: mapped.value })
    } catch (error: unknown) {
      return failure(new FindApiKeyError({ error }))
    }
  }
}
```

- [ ] **Step 14: Run the repository test again.** Expected PASS.

- [ ] **Step 15: Type-check and lint.**

- [ ] **Step 16: Commit**

```bash
git add apps/core-server/prisma/schema/api-key.prisma apps/core-server/prisma/migrations apps/core-server/src/modules/api-keys/domain apps/core-server/src/modules/api-keys/infrastructure
git commit -m "feat(core-server): add api-keys module data layer and SHA-256 hashing"
```

---

### Task 8: `ApiKeyAuthGuard` + `ApiKeysModule`

**Files:**
- Create: `apps/core-server/src/modules/api-keys/infrastructure/http/authenticated-tenant.ts`
- Create: `apps/core-server/src/modules/api-keys/infrastructure/http/authenticated-tenant.decorator.ts`
- Create: `apps/core-server/src/modules/api-keys/infrastructure/http/api-key-auth.guard.ts`
- Create: `apps/core-server/src/modules/api-keys/infrastructure/http/__tests__/api-key-auth.guard.unit.ts`
- Create: `apps/core-server/src/modules/api-keys/domain/errors/api-key-unauthorized.error.ts`
- Create: `apps/core-server/src/modules/api-keys/api-keys.module.ts`

**Interfaces:**
- Consumes: `ApiKeyRepository` (Task 7), `ProjectLookupProvider` (Task 4),
  `IGetOrSetCacheProvider`/`GET_OR_SET_CACHE_PROVIDER` (`@ruguin/cache`), `coreServerENV.API_KEY_CACHE_TTL_IN_SECONDS`
  (Task 1).
- Produces: `AuthenticatedTenant` type (`{ projectId: string; organizationId: string }`);
  `@AuthenticatedTenant()` param decorator; `ApiKeyAuthGuard` (throws `ApiKeyUnauthorizedError` on
  missing/unknown/revoked key, attaches the tenant to the request on success); `ApiKeysModule`
  (imports `ProjectsModule`, exports `ApiKeyAuthGuard`). Consumed by Task 12 (`EmailController`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/core-server/src/modules/api-keys/infrastructure/http/__tests__/api-key-auth.guard.unit.ts
import { type ExecutionContext } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { CacheLockOutcome, CacheSource, type IGetOrSetCacheProvider } from '@ruguin/cache'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type ApiKeyRepository } from '../../../domain/contracts/api-key.repository'
import { FindApiKeyError } from '../../../domain/errors/find-api-key.error'
import { ApiKey } from '../../../domain/models/api-key.model'
import { hashApiKey } from '../../../domain/hash-api-key'
import { type ProjectLookupProvider } from '../../../../projects/domain/contracts/project-lookup.provider'
import { Project } from '../../../../projects/domain/models/project.model'
import { ApiKeyAuthGuard } from '../api-key-auth.guard'
import { type AuthenticatedRequest } from '../authenticated-tenant'

function validId(modelName: string): ID {
  const generated = ID.generate({ modelName })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function createContext(authorizationHeader: string | undefined) {
  const request = { headers: { authorization: authorizationHeader } } as AuthenticatedRequest
  const context = {
    switchToHttp: () => ({ getRequest: () => request })
  } as unknown as ExecutionContext

  return { context, request }
}

function buildApiKey(revokedAt: Date | null) {
  const created = ApiKey.create({
    id: validId('ApiKey'),
    projectId: 'project-1',
    hashedKey: hashApiKey({ rawKey: 'sk-valid' }),
    revokedAt,
    createdAt: new Date()
  })
  if (created.isFailure()) throw new Error('unreachable')
  return created.value
}

function buildProject() {
  const created = Project.create({ id: validId('Project'), organizationId: 'org-1', name: 'Prod', createdAt: new Date() })
  if (created.isFailure()) throw new Error('unreachable')
  return created.value
}

/*
 * Mirrors what the real GetOrSetCacheProvider does: run the loader, and on success wrap its value
 * in the { value, source, lockOutcome } envelope the contract promises — a passthrough stub would
 * hand the guard `AuthenticatedTenant` where it expects `{ value: AuthenticatedTenant | null, ... }`
 * and silently break `cached.value.value`.
 */
function createCacheStub(): IGetOrSetCacheProvider {
  return {
    getOrSet: vi.fn(async ({ loader }) => {
      const loaded = await loader()
      if (loaded.isFailure()) return loaded

      return success({ value: loaded.value, source: CacheSource.LOADER, lockOutcome: CacheLockOutcome.NOT_ATTEMPTED })
    })
  }
}

describe('ApiKeyAuthGuard', () => {
  it('rejects a request with no Authorization header', async () => {
    const apiKeyRepository = { findActiveByHashedKey: vi.fn() } as unknown as ApiKeyRepository
    const projectLookup = { findById: vi.fn() } as unknown as ProjectLookupProvider
    const guard = new ApiKeyAuthGuard(apiKeyRepository, projectLookup, createCacheStub())
    const { context } = createContext(undefined)

    await expect(guard.canActivate(context)).rejects.toThrow('Missing or malformed Authorization header')
  })

  it('rejects an unknown or revoked API key', async () => {
    const apiKeyRepository = {
      findActiveByHashedKey: vi.fn().mockResolvedValue(success({ apiKey: null }))
    } as unknown as ApiKeyRepository
    const projectLookup = { findById: vi.fn() } as unknown as ProjectLookupProvider
    const guard = new ApiKeyAuthGuard(apiKeyRepository, projectLookup, createCacheStub())
    const { context } = createContext('Bearer sk-unknown')

    await expect(guard.canActivate(context)).rejects.toThrow('Unknown or revoked API key')
  })

  it('propagates an infrastructure failure from the API key lookup', async () => {
    const apiKeyRepository = {
      findActiveByHashedKey: vi.fn().mockResolvedValue(failure(new FindApiKeyError({})))
    } as unknown as ApiKeyRepository
    const projectLookup = { findById: vi.fn() } as unknown as ProjectLookupProvider
    const guard = new ApiKeyAuthGuard(apiKeyRepository, projectLookup, createCacheStub())
    const { context } = createContext('Bearer sk-valid')

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(FindApiKeyError)
  })

  it('attaches { projectId, organizationId } to the request for a valid, active key', async () => {
    const apiKeyRepository = {
      findActiveByHashedKey: vi.fn().mockResolvedValue(success({ apiKey: buildApiKey(null) }))
    } as unknown as ApiKeyRepository
    const projectLookup = {
      findById: vi.fn().mockResolvedValue(success({ project: buildProject() }))
    } as unknown as ProjectLookupProvider
    const guard = new ApiKeyAuthGuard(apiKeyRepository, projectLookup, createCacheStub())
    const { context, request } = createContext('Bearer sk-valid')

    const result = await guard.canActivate(context)

    expect(result).toBe(true)
    expect(request.authenticatedTenant).toEqual({ projectId: 'project-1', organizationId: 'org-1' })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ruguin/core-server test -- api-key-auth.guard.unit`
Expected: FAIL — `../api-key-auth.guard` does not exist.

- [ ] **Step 3: Implement `AuthenticatedTenant`, the decorator, and `ApiKeyUnauthorizedError`**

```ts
// apps/core-server/src/modules/api-keys/infrastructure/http/authenticated-tenant.ts
import { type FastifyRequest } from 'fastify'

export type AuthenticatedTenant = Readonly<{ projectId: string; organizationId: string }>

export type AuthenticatedRequest = FastifyRequest & { authenticatedTenant?: AuthenticatedTenant }
```

```ts
// apps/core-server/src/modules/api-keys/infrastructure/http/authenticated-tenant.decorator.ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common'

import { type AuthenticatedRequest, type AuthenticatedTenant } from './authenticated-tenant'

export const AuthenticatedTenantParam = createParamDecorator((_data: unknown, context: ExecutionContext): AuthenticatedTenant => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>()

  // ApiKeyAuthGuard always runs first and always sets this or throws — an undefined tenant here
  // means the guard was skipped, which is a wiring bug in the controller, not a request to reject.
  if (request.authenticatedTenant === undefined) {
    throw new Error('AuthenticatedTenantParam used on a route with no ApiKeyAuthGuard.')
  }

  return request.authenticatedTenant
})
```

```ts
// apps/core-server/src/modules/api-keys/domain/errors/api-key-unauthorized.error.ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class ApiKeyUnauthorizedError extends BaseError {
  readonly name = 'ApiKeyUnauthorizedError'
  readonly status = StatusError.UNAUTHORIZED

  constructor(input: { reason: string }) {
    super({ message: `${input.reason}.` })
  }
}
```

- [ ] **Step 4: Implement `ApiKeyAuthGuard`**

```ts
// apps/core-server/src/modules/api-keys/infrastructure/http/api-key-auth.guard.ts
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common'
import { GET_OR_SET_CACHE_PROVIDER, type IGetOrSetCacheProvider } from '@ruguin/cache'
import { coreServerENV } from '@ruguin/env'
import { type Either, success } from '@ruguin/utils'

import { API_KEY_REPOSITORY, type ApiKeyRepository } from '../../domain/contracts/api-key.repository'
import { ApiKeyUnauthorizedError } from '../../domain/errors/api-key-unauthorized.error'
import { type FindApiKeyError } from '../../domain/errors/find-api-key.error'
import { hashApiKey } from '../../domain/hash-api-key'
import { PROJECT_LOOKUP_PROVIDER, type ProjectLookupProvider } from '../../../projects/domain/contracts/project-lookup.provider'
import { type FindProjectError } from '../../../projects/domain/errors/find-project.error'

import { type AuthenticatedRequest, type AuthenticatedTenant } from './authenticated-tenant'

const BEARER_PREFIX = 'Bearer '

@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(
    @Inject(API_KEY_REPOSITORY) private readonly apiKeyRepository: ApiKeyRepository,
    @Inject(PROJECT_LOOKUP_PROVIDER) private readonly projectLookup: ProjectLookupProvider,
    @Inject(GET_OR_SET_CACHE_PROVIDER) private readonly cache: IGetOrSetCacheProvider
  ) {}

  private async resolveTenant(hashedKey: string): Promise<Either<FindApiKeyError | FindProjectError, AuthenticatedTenant | null>> {
    const apiKeyResult = await this.apiKeyRepository.findActiveByHashedKey({ hashedKey })
    if (apiKeyResult.isFailure()) return apiKeyResult
    if (apiKeyResult.value.apiKey === null) return success(null)

    const projectResult = await this.projectLookup.findById({ projectId: apiKeyResult.value.apiKey.projectId })
    if (projectResult.isFailure()) return projectResult
    if (projectResult.value.project === null) return success(null)

    return success({
      projectId: projectResult.value.project.id.toString(),
      organizationId: projectResult.value.project.organizationId
    })
  }

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const header = request.headers.authorization

    if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
      throw new ApiKeyUnauthorizedError({ reason: 'Missing or malformed Authorization header' })
    }

    const rawKey = header.slice(BEARER_PREFIX.length).trim()
    if (rawKey.length === 0) {
      throw new ApiKeyUnauthorizedError({ reason: 'Missing or malformed Authorization header' })
    }

    const hashedKey = hashApiKey({ rawKey })

    const cached = await this.cache.getOrSet<AuthenticatedTenant, FindApiKeyError | FindProjectError>({
      key: hashedKey,
      namespace: 'core-server:api-key',
      ttlInMs: coreServerENV.API_KEY_CACHE_TTL_IN_SECONDS * 1000,
      loader: () => this.resolveTenant(hashedKey)
    })

    if (cached.isFailure()) throw cached.value
    if (cached.value.value === null) {
      throw new ApiKeyUnauthorizedError({ reason: 'Unknown or revoked API key' })
    }

    request.authenticatedTenant = cached.value.value

    return true
  }
}
```

- [ ] **Step 5: Run the test again**

Run: `pnpm --filter @ruguin/core-server test -- api-key-auth.guard.unit`
Expected: PASS

- [ ] **Step 6: Implement `ApiKeysModule`**

```ts
// apps/core-server/src/modules/api-keys/api-keys.module.ts
import { Module } from '@nestjs/common'

import { ProjectsModule } from '../projects/projects.module'

import { API_KEY_REPOSITORY } from './domain/contracts/api-key.repository'
import { ApiKeyRepository } from './infrastructure/database/prisma/api-key.repository'
import { ApiKeyAuthGuard } from './infrastructure/http/api-key-auth.guard'

@Module({
  imports: [ProjectsModule],
  providers: [ApiKeyRepository, { provide: API_KEY_REPOSITORY, useExisting: ApiKeyRepository }, ApiKeyAuthGuard],
  exports: [ApiKeyAuthGuard]
})
export class ApiKeysModule {}
```

- [ ] **Step 7: Type-check and lint.**

- [ ] **Step 8: Commit**

```bash
git add apps/core-server/src/modules/api-keys
git commit -m "feat(core-server): add ApiKeyAuthGuard with cached tenant resolution"
```

---

### Task 9: `emails` module — `Email` domain model + Prisma schema

**Files:**
- Create: `apps/core-server/prisma/schema/email.prisma`
- Create: `apps/core-server/src/modules/emails/domain/models/email.model.ts`
- Create: `apps/core-server/src/modules/emails/domain/models/__tests__/email.model.unit.ts`
- Create: `apps/core-server/src/modules/emails/domain/errors/models/invalid-email.error.ts`

**Interfaces:**
- Produces: `Email` model (`id: ID`, `projectId: string`, `templateId: string | null`,
  `idempotencyKey: string | null`, `from: string`, `to: string`, `subject: string`, `html: string`,
  `createdAt: Date`). Consumed by Task 10 (`EmailRepository`) and Task 11 (`SendEmailUseCase`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/core-server/src/modules/emails/domain/models/__tests__/email.model.unit.ts
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
      templateId: null,
      idempotencyKey: null,
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      createdAt: new Date('2026-08-04T00:00:00Z')
    })

    expect(result.isSuccess()).toBe(true)
  })

  it('rejects an empty "from"', () => {
    const result = Email.create({
      id: validId(),
      projectId: 'project-1',
      templateId: null,
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
      templateId: null,
      idempotencyKey: null,
      from: 'sender@example.com',
      to: '',
      subject: 'Hello',
      html: '<p>Hello</p>',
      createdAt: new Date()
    })

    expect(result.isFailure()).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement `InvalidEmailError` and `Email`**

```ts
// apps/core-server/src/modules/emails/domain/errors/models/invalid-email.error.ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class InvalidEmailError extends BaseError {
  readonly name = 'InvalidEmailError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { reason: string }) {
    super({ message: `Invalid email: ${input.reason}.` })
  }
}
```

```ts
// apps/core-server/src/modules/emails/domain/models/email.model.ts
import { type ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidEmailError } from '../errors/models/invalid-email.error'

export class Email {
  private constructor(
    readonly id: ID,
    readonly projectId: string,
    readonly templateId: string | null,
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
    templateId: string | null
    idempotencyKey: string | null
    from: string
    to: string
    subject: string
    html: string
    createdAt: Date
  }): Either<InvalidEmailError, Email> {
    if (input.from.trim().length === 0) return failure(new InvalidEmailError({ reason: '"from" is empty' }))
    if (input.to.trim().length === 0) return failure(new InvalidEmailError({ reason: '"to" is empty' }))
    if (input.subject.trim().length === 0) return failure(new InvalidEmailError({ reason: 'subject is empty' }))
    if (input.html.trim().length === 0) return failure(new InvalidEmailError({ reason: 'html is empty' }))

    return success(
      new Email(
        input.id,
        input.projectId,
        input.templateId,
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

- [ ] **Step 4: Run the test again.** Expected PASS.

- [ ] **Step 5: Write the Prisma schema**

```prisma
// apps/core-server/prisma/schema/email.prisma
model Email {
  id             String      @id @default(uuid(7))
  projectId      String
  templateId     String?
  idempotencyKey String?
  from           String
  to             String
  subject        String
  html           String
  status         EmailStatus @default(QUEUED)
  createdAt      DateTime    @default(now())

  @@index([projectId])
  @@map("emails")
}

enum EmailStatus {
  QUEUED
}
```

- [ ] **Step 6: Create the migration WITHOUT applying it**

Run: `pnpm with-env pnpm --filter @ruguin/core-server exec prisma migrate dev --create-only --name add_emails`

This generates `apps/core-server/prisma/migrations/<timestamp>_add_emails/migration.sql` without
running it — same two-step sequence the outbox partitioning migration used (see
`docs/superpowers/plans/2026-08-02-core-server-outbox-pattern.md`, Task 2). Applying it immediately
(plain `db:migrate`) would leave no chance to hand-edit before Prisma records it as applied.

- [ ] **Step 7: Hand-edit the generated migration to add the partial idempotency index**

The Prisma DSL cannot express a partial index — same situation the outbox table's partitioning is
in (see `apps/core-server/prisma/migrations/20260802060821_add_outbox_partitioning/migration.sql`
for the precedent). Open the newly generated `migration.sql` and append:

```sql
-- A plain @@unique([projectId, idempotencyKey]) would reject every second email that omits
-- Idempotency-Key, since NULL <> NULL only holds for non-partial unique indexes in intent, not
-- in Postgres's actual NULL-handling — a standard unique index already treats multiple NULLs as
-- distinct. This index exists to be explicit about scope (idempotencyKey IS NOT NULL) and to
-- document, at the SQL level, that the constraint is intentionally partial, matching the design
-- spec (docs/superpowers/specs/2026-08-04-core-server-auth-and-send-design.md, decision 2).
CREATE UNIQUE INDEX "emails_project_idempotency_key_key"
  ON "emails" ("projectId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
```

- [ ] **Step 8: Apply the hand-edited migration**

Run: `pnpm with-env pnpm --filter @ruguin/core-server db:deploy`
Run: `pnpm --filter @ruguin/core-server db:generate`

- [ ] **Step 9: Verify the partial index exists**

Run:
```bash
docker compose exec postgres psql -U ruguin -d ruguin -c "\d core_server.emails"
```
Expected: `emails_project_idempotency_key_key` listed among the indexes, with a `WHERE` clause.

- [ ] **Step 10: Type-check and lint.**

- [ ] **Step 11: Commit**

```bash
git add apps/core-server/prisma/schema/email.prisma apps/core-server/prisma/migrations apps/core-server/src/modules/emails/domain/models apps/core-server/src/modules/emails/domain/errors
git commit -m "feat(core-server): add Email domain model and emails table with partial idempotency index"
```

---

### Task 10: `EmailRepository.createIfNotExists` — idempotency under concurrency

**Files:**
- Create: `apps/core-server/src/modules/emails/domain/contracts/repositories/email.repository.ts`
- Create: `apps/core-server/src/modules/emails/domain/errors/models/create-email.error.ts`
- Create: `apps/core-server/src/modules/emails/infrastructure/database/prisma/email.repository.ts`
- Create: `apps/core-server/src/modules/emails/infrastructure/database/prisma/__tests__/email.repository.unit.ts`
- Create: `apps/core-server/src/modules/emails/infrastructure/database/prisma/__tests__/email.repository.int.ts`

**Interfaces:**
- Consumes: `TransactionContext` (`shared/domain/contracts/transaction-context.contract.ts`),
  `Prisma.PrismaClientKnownRequestError`/`Prisma.TransactionClient` (generated client).
- Produces: `EmailRepository.createIfNotExists(input: { email: Email; tx: TransactionContext }): Promise<Either<CreateEmailError, { email: Email; created: boolean }>>`;
  `EMAIL_REPOSITORY` DI token. Consumed by Task 11 (`SendEmailUseCase`).

- [ ] **Step 1: Write the failing unit test (mocked transaction client)**

```ts
// apps/core-server/src/modules/emails/infrastructure/database/prisma/__tests__/email.repository.unit.ts
import { ID } from '@ruguin/shared-domain'
import { describe, expect, it, vi } from 'vitest'

import { type TransactionContext } from '../../../../../shared/domain/contracts/transaction-context.contract'
import { Email } from '../../../../domain/models/email.model'
import { EmailRepository } from '../email.repository'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Email' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildEmail(idempotencyKey: string | null) {
  const result = Email.create({
    id: validId(),
    projectId: 'project-1',
    templateId: null,
    idempotencyKey,
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Hello',
    html: '<p>Hello</p>',
    createdAt: new Date('2026-08-04T00:00:00Z')
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

function createTxStub(input: { create: (data: Record<string, unknown>) => Promise<unknown>; findFirst?: () => Promise<unknown> }) {
  return {
    email: {
      create: ({ data }: { data: Record<string, unknown> }) => input.create(data),
      findFirst: input.findFirst ?? (() => Promise.resolve(null))
    }
  } as unknown as TransactionContext
}

describe('EmailRepository#createIfNotExists', () => {
  it('returns created: true and the persisted row on a fresh insert', async () => {
    const email = buildEmail('idem-1')
    const repository = new EmailRepository()
    const tx = createTxStub({
      create: (data) =>
        Promise.resolve({
          id: data.id,
          projectId: data.projectId,
          templateId: data.templateId,
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
      templateId: null,
      idempotencyKey: 'idem-1',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      createdAt: new Date('2026-08-04T00:00:00Z')
    }
    const repository = new EmailRepository()
    const tx = createTxStub({
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
  })

  it('maps any other thrown error into CreateEmailError', async () => {
    const email = buildEmail(null)
    const repository = new EmailRepository()
    const tx = createTxStub({
      create: () => {
        throw new Error('connection terminated unexpectedly')
      }
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
  })
})
```

_Note: this mock does not actually distinguish a `PrismaClientKnownRequestError` by prototype
(Vitest can't cheaply construct the real Prisma error class) — Step 3's implementation must check
`error.code === 'P2002'` structurally (`'code' in error && error.code === 'P2002'`), not with
`instanceof`, so this stub-based test exercises the same branch the real error would._

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ruguin/core-server test -- email.repository.unit`
Expected: FAIL — `../email.repository` does not exist.

- [ ] **Step 3: Implement `CreateEmailError`, the `EmailRepository` contract, and its Prisma adapter**

```ts
// apps/core-server/src/modules/emails/domain/errors/models/create-email.error.ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class CreateEmailError extends BaseError {
  readonly name = 'CreateEmailError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to persist the email.' })
  }
}
```

```ts
// apps/core-server/src/modules/emails/domain/contracts/repositories/email.repository.ts
import { type Either } from '@ruguin/utils'

import { type TransactionContext } from '../../../../../shared/domain/contracts/transaction-context.contract'
import { type CreateEmailError } from '../../errors/models/create-email.error'
import { type Email } from '../../models/email.model'

export const EMAIL_REPOSITORY = Symbol('EMAIL_REPOSITORY')

export interface EmailRepository {
  createIfNotExists(input: {
    email: Email
    tx: TransactionContext
  }): Promise<Either<CreateEmailError, { email: Email; created: boolean }>>
}
```

```ts
// apps/core-server/src/modules/emails/infrastructure/database/prisma/email.repository.ts
import { Injectable } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { type TransactionContext } from '../../../../../shared/domain/contracts/transaction-context.contract'
import { type Prisma } from '../../../../../shared/infrastructure/database/prisma/generated/client'
import { type EmailRepository as EmailRepositoryContract } from '../../../domain/contracts/repositories/email.repository'
import { CreateEmailError } from '../../../domain/errors/models/create-email.error'
import { InvalidEmailError } from '../../../domain/errors/models/invalid-email.error'
import { Email } from '../../../domain/models/email.model'

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002'
}

@Injectable()
export class EmailRepository implements EmailRepositoryContract {
  private toDomain(row: {
    id: string
    projectId: string
    templateId: string | null
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
      idempotencyKey: row.idempotencyKey,
      from: row.from,
      to: row.to,
      subject: row.subject,
      html: row.html,
      createdAt: row.createdAt
    })
  }

  public async createIfNotExists(input: {
    email: Email
    tx: TransactionContext
  }): Promise<Either<CreateEmailError, { email: Email; created: boolean }>> {
    const client = input.tx as unknown as Prisma.TransactionClient

    try {
      const row = await client.email.create({
        data: {
          id: input.email.id.toString(),
          projectId: input.email.projectId,
          templateId: input.email.templateId,
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

      /*
       * Lost the race on (projectId, idempotencyKey): the winner's row is what the caller must
       * treat as the result — never a second outbox event for the same logical request. The
       * partial index guarantees at most one row exists here, so findFirst is not itself racy.
       */
      const existingRow = await client.email.findFirst({
        where: { projectId: input.email.projectId, idempotencyKey: input.email.idempotencyKey }
      })
      if (existingRow === null) return failure(new CreateEmailError({ error }))

      const mapped = this.toDomain(existingRow)
      if (mapped.isFailure()) return failure(new CreateEmailError({ error: mapped.value }))

      return success({ email: mapped.value, created: false })
    }
  }
}
```

- [ ] **Step 4: Run the unit test again**

Run: `pnpm --filter @ruguin/core-server test -- email.repository.unit`
Expected: PASS

- [ ] **Step 5: Write the failing concurrency integration test**

```ts
// apps/core-server/src/modules/emails/infrastructure/database/prisma/__tests__/email.repository.int.ts
import { ID } from '@ruguin/shared-domain'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestPrismaService } from '../../../../../shared/infrastructure/outbox/__tests__/outbox-test-context'
import { type TransactionContext } from '../../../../../shared/domain/contracts/transaction-context.contract'
import { Email } from '../../../../domain/models/email.model'
import { EmailRepository } from '../email.repository'

import { type PrismaService } from '../../../../../shared/infrastructure/database/prisma/prisma.service'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Email' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildEmail(input: { projectId: string; idempotencyKey: string | null }) {
  const result = Email.create({
    id: validId(),
    projectId: input.projectId,
    templateId: null,
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
      prisma.$transaction((tx) => repository.createIfNotExists({ email: first, tx: tx as unknown as TransactionContext })),
      prisma.$transaction((tx) => repository.createIfNotExists({ email: second, tx: tx as unknown as TransactionContext }))
    ])

    expect(firstResult.isSuccess()).toBe(true)
    expect(secondResult.isSuccess()).toBe(true)
    if (!firstResult.isSuccess() || !secondResult.isSuccess()) return

    const createdFlags = [firstResult.value.created, secondResult.value.created].sort()
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

- [ ] **Step 6: Run it to verify it fails, then passes**

Run: `docker compose up -d` (if not already up)
Run: `pnpm --filter @ruguin/core-server test:integration -- email.repository.int`
Expected: FAIL first if the migration/index from Task 9 is missing; PASS once Task 9 is committed
and applied (it is, from Task 9 Step 7-8).

- [ ] **Step 7: Type-check and lint.**

- [ ] **Step 8: Commit**

```bash
git add apps/core-server/src/modules/emails/domain/contracts apps/core-server/src/modules/emails/domain/errors/models/create-email.error.ts apps/core-server/src/modules/emails/infrastructure
git commit -m "feat(core-server): add EmailRepository.createIfNotExists with idempotency under concurrency"
```

---

### Task 11: `SendEmailUseCase`

**Files:**
- Create: `apps/core-server/src/modules/emails/application/use-cases/send-email.use-case.ts`
- Create: `apps/core-server/src/modules/emails/application/use-cases/__tests__/send-email.use-case.unit.ts`
- Modify: `apps/core-server/package.json` (add `@ruguin/event-schemas` dependency)

**Interfaces:**
- Consumes: `TransactionManager` (`shared/domain/contracts/transaction-manager.contract.ts`),
  `OutboxPort` (`shared/domain/contracts/outbox.port.ts`), `EmailRepository` (Task 10),
  `TemplateLookupProvider` (Task 5), `renderTemplate` (Task 6),
  `EmailSendRequestedPayloadSchema`/`EMAIL_SEND_REQUESTED_TOPIC` (`@ruguin/event-schemas`).
- Produces:
  `SendEmailUseCase.execute(input: SendEmailUseCaseInput): Promise<Either<BaseError, Email>>` where
  ```ts
  type SendEmailUseCaseInput = Readonly<{
    projectId: string
    organizationId: string
    from: string
    to: string
    idempotencyKey?: string
  }> &
    (
      | Readonly<{ templateId: string; variables: Record<string, string> }>
      | Readonly<{ subject: string; html: string }>
    )
  ```
  Consumed by Task 12 (`SendEmailService`/`EmailController`).

- [ ] **Step 1: Add `@ruguin/event-schemas` to `apps/core-server/package.json`**

In the `dependencies` block (alphabetical, next to `@ruguin/env`):

```json
    "@ruguin/event-schemas": "workspace:*",
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

```ts
// apps/core-server/src/modules/emails/application/use-cases/__tests__/send-email.use-case.unit.ts
import { ID } from '@ruguin/shared-domain'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type TransactionContext } from '../../../../../shared/domain/contracts/transaction-context.contract'
import { type TransactionManager } from '../../../../../shared/domain/contracts/transaction-manager.contract'
import { type OutboxPort } from '../../../../../shared/domain/contracts/outbox.port'
import { TemplateNotFoundError } from '../../../../templates/domain/errors/template-not-found.error'
import { Template } from '../../../../templates/domain/models/template.model'
import { type TemplateLookupProvider } from '../../../../templates/domain/contracts/template-lookup.provider'
import { type EmailRepository } from '../../../domain/contracts/repositories/email.repository'
import { CreateEmailError } from '../../../domain/errors/models/create-email.error'
import { Email } from '../../../domain/models/email.model'
import { SendEmailUseCase } from '../send-email.use-case'

function validId(modelName: string): ID {
  const generated = ID.generate({ modelName })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildTemplate() {
  const result = Template.create({
    id: validId('Template'),
    projectId: 'project-1',
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
    projectId: 'project-1',
    templateId: null,
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
    const email = buildEmail()
    const emailRepository: EmailRepository = {
      createIfNotExists: vi.fn().mockResolvedValue(success({ email, created: true }))
    }
    const templateLookup: TemplateLookupProvider = {
      findByIdAndProjectId: vi.fn().mockResolvedValue(success({ template: buildTemplate() }))
    }
    const outbox: OutboxPort = { enqueue: vi.fn().mockResolvedValue(success(undefined)) }
    const useCase = new SendEmailUseCase(createTransactionManagerStub(), emailRepository, templateLookup, outbox)

    const result = await useCase.execute({
      projectId: 'project-1',
      organizationId: 'org-1',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      templateId: buildTemplate().id.toString(),
      variables: { name: 'Ada' }
    })

    expect(result.isSuccess()).toBe(true)
    expect(outbox.enqueue).toHaveBeenCalledTimes(1)
    const [event, options] = (outbox.enqueue as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { name: string; payload: unknown },
      { topic: string; key: string }
    ]
    expect(options.topic).toBe('email.send.requested')
    expect(event.payload).toMatchObject({ organizationId: 'org-1', projectId: 'project-1' })
  })

  it('does not enqueue a second event when the row already existed (idempotent replay)', async () => {
    const email = buildEmail({ idempotencyKey: 'idem-1' })
    const emailRepository: EmailRepository = {
      createIfNotExists: vi.fn().mockResolvedValue(success({ email, created: false }))
    }
    const outbox: OutboxPort = { enqueue: vi.fn() }
    const useCase = new SendEmailUseCase(createTransactionManagerStub(), emailRepository, { findByIdAndProjectId: vi.fn() }, outbox)

    const result = await useCase.execute({
      projectId: 'project-1',
      organizationId: 'org-1',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      idempotencyKey: 'idem-1'
    })

    expect(result.isSuccess()).toBe(true)
    expect(outbox.enqueue).not.toHaveBeenCalled()
  })

  it('fails with TemplateNotFoundError when the templateId does not resolve for this project', async () => {
    const templateLookup: TemplateLookupProvider = {
      findByIdAndProjectId: vi.fn().mockResolvedValue(success({ template: null }))
    }
    const emailRepository: EmailRepository = { createIfNotExists: vi.fn() }
    const outbox: OutboxPort = { enqueue: vi.fn() }
    const useCase = new SendEmailUseCase(createTransactionManagerStub(), emailRepository, templateLookup, outbox)

    const result = await useCase.execute({
      projectId: 'project-1',
      organizationId: 'org-1',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      templateId: 'missing-template',
      variables: {}
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(TemplateNotFoundError)
    expect(emailRepository.createIfNotExists).not.toHaveBeenCalled()
  })

  it('fails with MissingTemplateVariableError and never persists when a variable is missing', async () => {
    const templateLookup: TemplateLookupProvider = {
      findByIdAndProjectId: vi.fn().mockResolvedValue(success({ template: buildTemplate() }))
    }
    const emailRepository: EmailRepository = { createIfNotExists: vi.fn() }
    const outbox: OutboxPort = { enqueue: vi.fn() }
    const useCase = new SendEmailUseCase(createTransactionManagerStub(), emailRepository, templateLookup, outbox)

    const result = await useCase.execute({
      projectId: 'project-1',
      organizationId: 'org-1',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      templateId: buildTemplate().id.toString(),
      variables: {}
    })

    expect(result.isFailure()).toBe(true)
    expect(emailRepository.createIfNotExists).not.toHaveBeenCalled()
  })

  it('uses subject/html directly when no templateId is given', async () => {
    const email = buildEmail()
    const emailRepository: EmailRepository = {
      createIfNotExists: vi.fn().mockResolvedValue(success({ email, created: true }))
    }
    const outbox: OutboxPort = { enqueue: vi.fn().mockResolvedValue(success(undefined)) }
    const useCase = new SendEmailUseCase(createTransactionManagerStub(), emailRepository, { findByIdAndProjectId: vi.fn() }, outbox)

    const result = await useCase.execute({
      projectId: 'project-1',
      organizationId: 'org-1',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>'
    })

    expect(result.isSuccess()).toBe(true)
  })

  it('propagates a repository failure without enqueueing', async () => {
    const emailRepository: EmailRepository = {
      createIfNotExists: vi.fn().mockResolvedValue(failure(new CreateEmailError({ error: new Error('db down') })))
    }
    const outbox: OutboxPort = { enqueue: vi.fn() }
    const useCase = new SendEmailUseCase(createTransactionManagerStub(), emailRepository, { findByIdAndProjectId: vi.fn() }, outbox)

    const result = await useCase.execute({
      projectId: 'project-1',
      organizationId: 'org-1',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>'
    })

    expect(result.isFailure()).toBe(true)
    expect(outbox.enqueue).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @ruguin/core-server test -- send-email.use-case.unit`
Expected: FAIL — `TemplateNotFoundError`, `../send-email.use-case` do not exist yet.

- [ ] **Step 4: Implement `TemplateNotFoundError`**

```ts
// apps/core-server/src/modules/templates/domain/errors/template-not-found.error.ts
import { BaseError, StatusError } from '@ruguin/shared-domain'

export class TemplateNotFoundError extends BaseError {
  readonly name = 'TemplateNotFoundError'
  readonly status = StatusError.NOT_FOUND

  constructor(input: { templateId: string }) {
    super({ message: `Template "${input.templateId}" was not found for this project.` })
  }
}
```

- [ ] **Step 5: Implement `SendEmailUseCase`**

```ts
// apps/core-server/src/modules/emails/application/use-cases/send-email.use-case.ts
import { Inject, Injectable } from '@nestjs/common'
import { type BaseError, Event, ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'
import { EMAIL_SEND_REQUESTED_TOPIC, EmailSendRequestedPayloadSchema } from '@ruguin/event-schemas'

import { OUTBOX_PORT, type OutboxPort } from '../../../../shared/domain/contracts/outbox.port'
import { TRANSACTION_MANAGER, type TransactionManager } from '../../../../shared/domain/contracts/transaction-manager.contract'
import { EMAIL_REPOSITORY, type EmailRepository } from '../../domain/contracts/repositories/email.repository'
import { Email } from '../../domain/models/email.model'
import { renderTemplate } from '../../../templates/domain/render-template'
import {
  TEMPLATE_LOOKUP_PROVIDER,
  type TemplateLookupProvider
} from '../../../templates/domain/contracts/template-lookup.provider'
import { TemplateNotFoundError } from '../../../templates/domain/errors/template-not-found.error'

export type SendEmailUseCaseInput = Readonly<{
  projectId: string
  organizationId: string
  from: string
  to: string
  idempotencyKey?: string
}> &
  (Readonly<{ templateId: string; variables: Record<string, string> }> | Readonly<{ subject: string; html: string }>)

@Injectable()
export class SendEmailUseCase {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly transactionManager: TransactionManager,
    @Inject(EMAIL_REPOSITORY) private readonly emailRepository: EmailRepository,
    @Inject(TEMPLATE_LOOKUP_PROVIDER) private readonly templateLookup: TemplateLookupProvider,
    @Inject(OUTBOX_PORT) private readonly outbox: OutboxPort
  ) {}

  public async execute(input: SendEmailUseCaseInput): Promise<Either<BaseError, Email>> {
    let subject: string
    let html: string
    let templateId: string | null = null

    if ('templateId' in input) {
      const templateResult = await this.templateLookup.findByIdAndProjectId({
        templateId: input.templateId,
        projectId: input.projectId
      })
      if (templateResult.isFailure()) return templateResult
      if (templateResult.value.template === null) {
        return failure(new TemplateNotFoundError({ templateId: input.templateId }))
      }

      const rendered = renderTemplate({
        subject: templateResult.value.template.subject,
        html: templateResult.value.template.html,
        variables: input.variables
      })
      if (rendered.isFailure()) return rendered

      subject = rendered.value.subject
      html = rendered.value.html
      templateId = input.templateId
    } else {
      subject = input.subject
      html = input.html
    }

    const idGenerated = ID.generate({ modelName: 'Email' })
    if (idGenerated.isFailure()) {
      // Same posture as Event.create(): UUID generation itself failing is treated as a bug, not
      // an expected domain failure — there is no meaningful recovery for the caller here.
      throw new Error(`Failed to generate an id for a new email: ${idGenerated.value.message}`)
    }

    const emailResult = Email.create({
      id: idGenerated.value.idGenerated,
      projectId: input.projectId,
      templateId,
      idempotencyKey: input.idempotencyKey ?? null,
      from: input.from,
      to: input.to,
      subject,
      html,
      createdAt: new Date()
    })
    if (emailResult.isFailure()) return emailResult

    return this.transactionManager.execute(async (tx) => {
      const createResult = await this.emailRepository.createIfNotExists({ email: emailResult.value, tx })
      if (createResult.isFailure()) return createResult

      const { email: persisted, created } = createResult.value

      if (created) {
        const payload = EmailSendRequestedPayloadSchema.parse({
          emailId: persisted.id.toString(),
          organizationId: input.organizationId,
          projectId: persisted.projectId,
          from: persisted.from,
          to: persisted.to,
          subject: persisted.subject,
          html: persisted.html,
          ...(persisted.idempotencyKey !== null && { idempotencyKey: persisted.idempotencyKey })
        })
        const event = Event.create(EMAIL_SEND_REQUESTED_TOPIC, payload)
        const enqueued = await this.outbox.enqueue(event, { topic: EMAIL_SEND_REQUESTED_TOPIC, key: persisted.projectId }, tx)
        if (enqueued.isFailure()) return enqueued
      }

      return success(persisted)
    })
  }
}
```

- [ ] **Step 6: Run the tests again**

Run: `pnpm --filter @ruguin/core-server test -- send-email.use-case.unit`
Expected: PASS

- [ ] **Step 7: Type-check and lint**

Run: `pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/core-server check:lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/core-server/package.json pnpm-lock.yaml apps/core-server/src/modules/emails/application apps/core-server/src/modules/templates/domain/errors/template-not-found.error.ts
git commit -m "feat(core-server): add SendEmailUseCase — render, persist idempotently, enqueue outbox event"
```

---

### Task 12: `EmailController` — `POST /emails`

**Files:**
- Create: `apps/core-server/src/modules/emails/presentation/dtos/send-email.dto.ts`
- Create: `apps/core-server/src/modules/emails/presentation/dtos/__tests__/send-email.dto.unit.ts`
- Create: `apps/core-server/src/modules/emails/domain/errors/models/invalid-send-email-request.error.ts`
- Create: `apps/core-server/src/modules/emails/application/services/send-email.service.ts`
- Create: `apps/core-server/src/modules/emails/presentation/controllers/email.controller.ts`
- Create: `apps/core-server/src/modules/emails/presentation/controllers/__tests__/email.controller.unit.ts`
- Modify: `apps/core-server/src/modules/emails/emails.module.ts`

**Interfaces:**
- Consumes: `SendEmailUseCase` (Task 11), `ApiKeyAuthGuard`/`AuthenticatedTenantParam` (Task 8).
- Produces: `POST /v1/emails` (via the already-registered `RoutesEmailsModule` → `/emails` prefix +
  global URI versioning) returning `202 { id, status: 'queued' }` on success, or the HTTP status
  `BaseErrorExceptionFilter` (Task 2) derives from whichever `BaseError` was thrown.

- [ ] **Step 1: Write the failing test for the DTO schema**

```ts
// apps/core-server/src/modules/emails/presentation/dtos/__tests__/send-email.dto.unit.ts
import { describe, expect, it } from 'vitest'

import { SendEmailBodySchema } from '../send-email.dto'

describe('SendEmailBodySchema', () => {
  it('accepts a template-based body', () => {
    const result = SendEmailBodySchema.safeParse({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      templateId: '0198f3b2-1234-7000-8000-000000000020',
      variables: { name: 'Ada' }
    })

    expect(result.success).toBe(true)
  })

  it('accepts a direct subject/html body', () => {
    const result = SendEmailBodySchema.safeParse({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>'
    })

    expect(result.success).toBe(true)
  })

  it('rejects a body with neither templateId nor subject+html', () => {
    const result = SendEmailBodySchema.safeParse({ from: 'sender@example.com', to: 'recipient@example.com' })

    expect(result.success).toBe(false)
  })

  it('rejects an invalid "from" address', () => {
    const result = SendEmailBodySchema.safeParse({
      from: 'not-an-email',
      to: 'recipient@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>'
    })

    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement `SendEmailBodySchema`**

```ts
// apps/core-server/src/modules/emails/presentation/dtos/send-email.dto.ts
import { z } from 'zod'

const SendEmailWithTemplateSchema = z.object({
  from: z.email(),
  to: z.email(),
  templateId: z.uuid(),
  variables: z.record(z.string(), z.string()).default({})
})

const SendEmailWithContentSchema = z.object({
  from: z.email(),
  to: z.email(),
  subject: z.string().min(1),
  html: z.string().min(1)
})

export const SendEmailBodySchema = z.union([SendEmailWithTemplateSchema, SendEmailWithContentSchema])

export type SendEmailBody = z.infer<typeof SendEmailBodySchema>
```

- [ ] **Step 4: Run the DTO test again.** Expected PASS.

- [ ] **Step 5: Write the failing controller test**

```ts
// apps/core-server/src/modules/emails/presentation/controllers/__tests__/email.controller.unit.ts
import { ID } from '@ruguin/shared-domain'
import { success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { InvalidSendEmailRequestError } from '../../../domain/errors/models/invalid-send-email-request.error'
import { Email } from '../../../domain/models/email.model'
import { type SendEmailService } from '../../../application/services/send-email.service'
import { EmailController } from '../email.controller'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Email' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildEmail() {
  const result = Email.create({
    id: validId(),
    projectId: 'project-1',
    templateId: null,
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

describe('EmailController#send', () => {
  it('returns { id, status: "queued" } on success', async () => {
    const email = buildEmail()
    const service: SendEmailService = { execute: vi.fn().mockResolvedValue(success(email)) }
    const controller = new EmailController(service)

    const response = await controller.send(
      { from: 'sender@example.com', to: 'recipient@example.com', subject: 'Hi', html: '<p>Hi</p>' },
      undefined,
      { projectId: 'project-1', organizationId: 'org-1' }
    )

    expect(response).toEqual({ id: email.id.toString(), status: 'queued' })
  })

  it('throws InvalidSendEmailRequestError for a body matching neither shape', async () => {
    const service: SendEmailService = { execute: vi.fn() }
    const controller = new EmailController(service)

    await expect(
      controller.send({ from: 'sender@example.com', to: 'recipient@example.com' }, undefined, {
        projectId: 'project-1',
        organizationId: 'org-1'
      })
    ).rejects.toBeInstanceOf(InvalidSendEmailRequestError)
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('throws whatever BaseError the service returns as a failure', async () => {
    class FakeError extends Error {}
    const service: SendEmailService = {
      execute: vi.fn().mockResolvedValue({ isFailure: () => true, isSuccess: () => false, value: new FakeError() })
    }
    const controller = new EmailController(service)

    await expect(
      controller.send({ from: 'sender@example.com', to: 'recipient@example.com', subject: 'Hi', html: '<p>Hi</p>' }, undefined, {
        projectId: 'project-1',
        organizationId: 'org-1'
      })
    ).rejects.toBeInstanceOf(FakeError)
  })
})
```

- [ ] **Step 6: Run it to verify it fails.**

- [ ] **Step 7: Implement `InvalidSendEmailRequestError`, `SendEmailService`, and `EmailController`**

```ts
// apps/core-server/src/modules/emails/domain/errors/models/invalid-send-email-request.error.ts
import { BaseError, StatusError } from '@ruguin/shared-domain'
import { type ZodIssue } from 'zod'

export class InvalidSendEmailRequestError extends BaseError {
  readonly name = 'InvalidSendEmailRequestError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { issues: readonly ZodIssue[] }) {
    super({
      error: input.issues,
      message: 'Request body must include either { templateId, variables } or { subject, html }.'
    })
  }
}
```

```ts
// apps/core-server/src/modules/emails/application/services/send-email.service.ts
import { Injectable } from '@nestjs/common'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

import { type Email } from '../../domain/models/email.model'
import { SendEmailUseCase, type SendEmailUseCaseInput } from '../use-cases/send-email.use-case'

/*
 * Forwards only — no branching, no repository access. Deliberate per CLAUDE.md: the controller's
 * signature stays uniform, and this is where a future cross-cutting concern (metrics, auditing)
 * attaches without touching the use case. Do not delete because it "does nothing" — that is the job.
 */
@Injectable()
export class SendEmailService {
  constructor(private readonly sendEmailUseCase: SendEmailUseCase) {}

  public execute(input: SendEmailUseCaseInput): Promise<Either<BaseError, Email>> {
    return this.sendEmailUseCase.execute(input)
  }
}
```

```ts
// apps/core-server/src/modules/emails/presentation/controllers/email.controller.ts
import { Body, Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common'

import { ApiKeyAuthGuard } from '../../../api-keys/infrastructure/http/api-key-auth.guard'
import { AuthenticatedTenantParam } from '../../../api-keys/infrastructure/http/authenticated-tenant.decorator'
import { type AuthenticatedTenant } from '../../../api-keys/infrastructure/http/authenticated-tenant'
import { InvalidSendEmailRequestError } from '../../domain/errors/models/invalid-send-email-request.error'
import { SendEmailService } from '../../application/services/send-email.service'
import { SendEmailBodySchema } from '../dtos/send-email.dto'

@Controller()
@UseGuards(ApiKeyAuthGuard)
export class EmailController {
  constructor(private readonly sendEmailService: SendEmailService) {}

  @Post()
  @HttpCode(202)
  public async send(
    @Body() rawBody: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @AuthenticatedTenantParam() tenant: AuthenticatedTenant
  ): Promise<{ id: string; status: 'queued' }> {
    const parsed = SendEmailBodySchema.safeParse(rawBody)
    if (!parsed.success) throw new InvalidSendEmailRequestError({ issues: parsed.error.issues })

    const result = await this.sendEmailService.execute({
      ...parsed.data,
      projectId: tenant.projectId,
      organizationId: tenant.organizationId,
      ...(idempotencyKey !== undefined && { idempotencyKey })
    })

    if (result.isFailure()) throw result.value

    return { id: result.value.id.toString(), status: 'queued' }
  }
}
```

- [ ] **Step 8: Run the controller test again**

Run: `pnpm --filter @ruguin/core-server test -- email.controller.unit`
Expected: PASS

- [ ] **Step 9: Wire everything into `EmailsModule`**

```ts
// apps/core-server/src/modules/emails/emails.module.ts
import { Module } from '@nestjs/common'

import { ApiKeysModule } from '../api-keys/api-keys.module'
import { TemplatesModule } from '../templates/templates.module'
import { OutboxModule } from '../../shared/infrastructure/outbox/outbox.module'

import { EMAIL_REPOSITORY } from './domain/contracts/repositories/email.repository'
import { EmailRepository } from './infrastructure/database/prisma/email.repository'
import { SendEmailService } from './application/services/send-email.service'
import { SendEmailUseCase } from './application/use-cases/send-email.use-case'
import { EmailController } from './presentation/controllers/email.controller'

@Module({
  imports: [ApiKeysModule, TemplatesModule, OutboxModule.forFeature({ module: 'email' })],
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

`apps/core-server/src/modules/emails/presentation/routes/routes.user.module.ts` already imports
`EmailsModule` and is already registered at `/emails` in
`apps/core-server/src/router/router.module.ts` — no change needed to either file.

- [ ] **Step 10: Type-check and lint.**

- [ ] **Step 11: Commit**

```bash
git add apps/core-server/src/modules/emails
git commit -m "feat(core-server): wire POST /emails — DTO, guard, service, controller"
```

---

### Task 13: Seed script

**Files:**
- Modify: `apps/core-server/prisma.config.ts`
- Create: `apps/core-server/prisma/seed.ts`
- Modify: `apps/core-server/package.json` (add `db:seed` script and `tsx` devDependency if absent)
- Modify: `apps/core-server/vitest.setup.e2e.ts`

**Interfaces:**
- Produces: one seeded `Organization`, `Project`, `Template`, and `ApiKey` row, with the raw API key
  printed once to stdout. Consumed by Task 14 (e2e tests) via the same seeded row, read back through
  `TEST_API_KEY`/`TEST_TEMPLATE_ID`/`TEST_PROJECT_ID` env vars the e2e setup writes after seeding.

- [ ] **Step 1: Add `migrations.seed` to `prisma.config.ts`**

```ts
// apps/core-server/prisma.config.ts
import { defineConfig } from 'prisma/config'

const databaseUrl = process.env.DATABASE_URL
const datasource = databaseUrl === undefined || databaseUrl === '' ? {} : { url: databaseUrl }

export default defineConfig({
  datasource,
  migrations: {
    path: './prisma/migrations',
    seed: 'tsx prisma/seed.ts'
  },
  schema: './prisma/schema'
})
```

- [ ] **Step 2: Confirm `tsx` is available**

`tsx` is already a root devDependency (`package.json` at repo root lists it under
`devDependencies`, confirmed during Task-1-through-12 `pnpm install` runs) — no per-app dependency
needed since `pnpm with-env` runs from the workspace root's `node_modules/.bin`.

- [ ] **Step 3: Write `prisma/seed.ts`**

```ts
// apps/core-server/prisma/seed.ts
import { randomBytes } from 'node:crypto'

import { PrismaPg } from '@prisma/adapter-pg'
import { createHash } from 'node:crypto'

import { PrismaClient } from '../src/shared/infrastructure/database/prisma/generated/client'

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL must be set to run the seed.')
  }

  const schema = new URL(connectionString).searchParams.get('schema')
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }, schema === null || schema === '' ? {} : { schema })
  })

  const organization = await prisma.organization.create({ data: { name: 'Dev Organization' } })
  const project = await prisma.project.create({ data: { organizationId: organization.id, name: 'Dev Project' } })
  const template = await prisma.template.create({
    data: { projectId: project.id, name: 'Welcome', subject: 'Hi {{name}}', html: '<p>Hi {{name}}</p>' }
  })

  // 32 bytes of entropy, hex-encoded — see design spec decision 9. Printed once; never
  // recoverable afterward, matching the guarantee that only its hash is ever persisted.
  const rawApiKey = randomBytes(32).toString('hex')
  const hashedKey = createHash('sha256').update(rawApiKey).digest('hex')
  await prisma.apiKey.create({ data: { projectId: project.id, hashedKey } })

  console.log('Seeded development data:')
  console.log(`  organizationId: ${organization.id}`)
  console.log(`  projectId:      ${project.id}`)
  console.log(`  templateId:     ${template.id}`)
  console.log(`  API key:        ${rawApiKey}`)
  console.log('This key is shown once. It is not recoverable — re-run the seed to mint a new one.')

  await prisma.$disconnect()
}

await main()
```

- [ ] **Step 4: Add the `db:seed` script**

In `apps/core-server/package.json`'s `scripts` block, alphabetically after `db:migrate`:

```json
    "db:seed": "prisma db seed",
```

- [ ] **Step 5: Run the seed against the local dev database**

Run: `docker compose up -d`
Run: `pnpm with-env pnpm --filter @ruguin/core-server db:seed`
Expected: prints `organizationId`, `projectId`, `templateId`, and a 64-character hex API key.

- [ ] **Step 6: Reuse the same seed for the e2e suite**

The e2e project (`vitest.config.ts`, `name: 'e2e'`) already runs `vitest.setup.e2e.ts` before every
suite. Extend it to seed once per test run and expose the seeded IDs/key through env vars the e2e
tests in Task 14 read:

```ts
// apps/core-server/vitest.setup.e2e.ts
import { execSync } from 'node:child_process'

process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin?schema=core_server'
process.env.ENVIRONMENT ??= 'test'

const seedOutput = execSync('pnpm exec tsx prisma/seed.ts', {
  cwd: new URL('.', import.meta.url).pathname,
  env: process.env,
  encoding: 'utf8'
})

const organizationId = /organizationId:\s+(\S+)/.exec(seedOutput)?.[1]
const projectId = /projectId:\s+(\S+)/.exec(seedOutput)?.[1]
const templateId = /templateId:\s+(\S+)/.exec(seedOutput)?.[1]
const apiKey = /API key:\s+(\S+)/.exec(seedOutput)?.[1]

if (organizationId === undefined || projectId === undefined || templateId === undefined || apiKey === undefined) {
  throw new Error(`Failed to parse seed output:\n${seedOutput}`)
}

process.env.TEST_SEEDED_ORGANIZATION_ID = organizationId
process.env.TEST_SEEDED_PROJECT_ID = projectId
process.env.TEST_SEEDED_TEMPLATE_ID = templateId
process.env.TEST_SEEDED_API_KEY = apiKey
```

- [ ] **Step 7: Run the existing e2e suite to confirm nothing broke**

Run: `pnpm --filter @ruguin/core-server test:e2e`
Expected: PASS (health/configure-app suites unaffected; the setup file now also seeds, which adds
a few seconds per run but should not fail).

- [ ] **Step 8: Type-check and lint.**

- [ ] **Step 9: Commit**

```bash
git add apps/core-server/prisma.config.ts apps/core-server/prisma/seed.ts apps/core-server/package.json apps/core-server/vitest.setup.e2e.ts
git commit -m "feat(core-server): add dev/test seed script for organization, project, template, api key"
```

---

### Task 14: E2E tests — EMAIL-3 + EMAIL-4 acceptance criteria

**Files:**
- Create: `apps/core-server/src/modules/emails/presentation/controllers/__tests__/email.controller.e2e.ts`

**Interfaces:**
- Consumes: `TEST_SEEDED_PROJECT_ID`, `TEST_SEEDED_TEMPLATE_ID`, `TEST_SEEDED_API_KEY` (Task 13,
  Step 6), `configureApp` (`shared/infrastructure/bootstrap/configure-app.ts`), `AppModule`.

- [ ] **Step 1: Write the e2e test**

```ts
// apps/core-server/src/modules/emails/presentation/controllers/__tests__/email.controller.e2e.ts
import { type NestFastifyApplication } from '@nestjs/platform-fastify'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AppModule } from '../../../../../app.module'
import { configureApp } from '../../../../../shared/infrastructure/bootstrap/configure-app'

const SEEDED_PROJECT_ID = process.env.TEST_SEEDED_PROJECT_ID as string
const SEEDED_TEMPLATE_ID = process.env.TEST_SEEDED_TEMPLATE_ID as string
const SEEDED_API_KEY = process.env.TEST_SEEDED_API_KEY as string

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
      payload: { from: 'sender@example.com', to: 'recipient@example.com', subject: 'Hi', html: '<p>Hi</p>' }
    })

    expect(response.statusCode).toBe(401)
  })

  it('returns 401 for an unknown API key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: 'Bearer not-a-real-key' },
      payload: { from: 'sender@example.com', to: 'recipient@example.com', subject: 'Hi', html: '<p>Hi</p>' }
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
      payload: {
        from: 'sender@example.com',
        to: 'recipient@example.com',
        templateId: SEEDED_TEMPLATE_ID,
        variables: { name: 'Ada' }
      }
    })

    expect(response.statusCode).toBe(202)
    expect(JSON.parse(response.body)).toMatchObject({ status: 'queued' })
  })

  it('returns 400 when the body has neither templateId nor subject+html', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { from: 'sender@example.com', to: 'recipient@example.com' }
    })

    expect(response.statusCode).toBe(400)
  })

  it('returns 404 for a templateId belonging to a different project', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: {
        from: 'sender@example.com',
        to: 'recipient@example.com',
        templateId: randomUUID(),
        variables: {}
      }
    })

    expect(response.statusCode).toBe(404)
  })

  it('returns 422 when the template references a variable that was not provided', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { from: 'sender@example.com', to: 'recipient@example.com', templateId: SEEDED_TEMPLATE_ID, variables: {} }
    })

    expect(response.statusCode).toBe(422)
  })

  it('returns the same id for two concurrent requests sharing an Idempotency-Key', async () => {
    const idempotencyKey = `idem-${randomUUID()}`
    const payload = { from: 'sender@example.com', to: 'recipient@example.com', subject: 'Hi', html: '<p>Hi</p>' }

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

- [ ] **Step 2: Run it**

Run: `docker compose up -d`
Run: `pnpm --filter @ruguin/core-server test:e2e -- email.controller.e2e`
Expected: PASS on all nine cases. `SEEDED_PROJECT_ID` is read but unused directly in assertions —
kept for parity with the other two seeded constants and in case a future case needs it; if lint
flags the unused `const`, remove that one line only.

- [ ] **Step 3: Run the full test suite to confirm no regression**

Run: `pnpm --filter @ruguin/core-server test:all`
Expected: every unit, integration, and e2e suite passes.

- [ ] **Step 4: Type-check and lint the whole app**

Run: `pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/core-server check:lint`
Expected: no errors.

- [ ] **Step 5: Run `detect_changes` before the final commit**

Per project convention (`CLAUDE.md`, GitNexus section): `detect_changes({scope: "compare", base_ref: "develop"})`
to confirm the diff only touches the expected symbols/modules before committing.

- [ ] **Step 6: Commit**

```bash
git add apps/core-server/src/modules/emails/presentation/controllers/__tests__/email.controller.e2e.ts
git commit -m "test(core-server): e2e coverage for EMAIL-3 and EMAIL-4 acceptance criteria"
```

---

## Post-plan verification

- [ ] `pnpm --filter @ruguin/core-server build` succeeds (Prisma generate + Nest build + ESM fix-up).
- [ ] `pnpm --filter @ruguin/core-server test:all` passes end to end.
- [ ] Manually confirm the pipeline: run `pnpm with-env pnpm --filter @ruguin/core-server start`,
  `POST /v1/emails` with the seeded key, then check `apps/dispatch-worker`'s logs (or Kafka UI at
  the port configured in `docker-compose`) for the consumed `email.send.requested` message and a
  resulting SES send attempt — this is the first time the two services are exercised together with
  a real event, which is the entire point of this plan.
