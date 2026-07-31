# Core Server — API Docs (Scalar) + Bootstrap Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add interactive OpenAPI documentation (Scalar) protected by Basic Auth, plus URI-based API versioning and Fastify-native HTTP hardening (helmet, compression), to `apps/core-server`.

**Architecture:** All wiring lives in a new testable `configure-app.ts` module, separate from `main.ts`'s entrypoint script — same separation-of-concerns pattern already used by `create-tracing-sdk.ts` vs `tracing.ts`. Basic Auth credentials come from a new typed `@ruguin/env` schema (`docsENV`). Since this plan is the first to actually import `@ruguin/env` at runtime (not just in tests/type-check), a pre-existing bug in its barrel exports — extensionless directory imports, unresolvable under Node's raw-TS strip-only loader — is fixed first (Task 1), verified with a direct Node reproduction before and after the fix.

**Tech Stack:** NestJS (`@nestjs/platform-fastify`), `@nestjs/swagger`, `@scalar/nestjs-api-reference`, `@fastify/basic-auth`, `@fastify/helmet`, `@fastify/compress`, `@ruguin/env` (`@t3-oss/env-core` + zod), Vitest.

## Global Constraints

- TypeScript strict mode everywhere (`@ruguin/typescript-config/base.json`) — do not weaken compiler options.
- Every package/app is ESM (`"type": "module"`).
- Fastify-native plugins only (`@fastify/*`) — never generic Express middleware (`helmet`, `compression`, `morgan`). `core-server` uses `@nestjs/platform-fastify`, not Express.
- `DOCS_USERNAME`/`DOCS_PASSWORD` are required in every environment (local, test, staging, production) — no dev fallback. Boot fails fast if unset.
- `/health` stays version-neutral (`VERSION_NEUTRAL`) after URI versioning is enabled; `defaultVersion: '1'` applies to every other controller.
- No separate JSON endpoint decision to make — `/docs-json` is in scope (confirmed with the user), served from the same in-memory OpenAPI document as `/docs`.
- No `Co-Authored-By` trailer in commits (this project's `.claude/settings.json` does not set `attribution.commit`).
- i18n (`nestjs-cls` + language interceptor) and OpenTelemetry metrics export are explicitly out of scope — separate future plans.

---

### Task 1: Fix `@ruguin/env` barrel imports for Node ESM

**Files:**
- Modify: `packages/env/src/index.ts`
- Modify: `packages/env/src/shared/index.ts`
- Modify: `packages/env/src/packages/index.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `@ruguin/env`'s public barrel (`loggerENV`, `serverENV`, `EnvironmentEnum`, `cacheENV`, `databaseENV`, `messageBrokerENV`, `tokenProviderENV`) resolvable under real Node ESM, not only under Vitest/`tsc`. Task 5 depends on this to import `docsENV` at runtime inside `apps/core-server`.

- [ ] **Step 1: Reproduce the bug**

Run: `node -e "import('./packages/env/src/index.ts').then(m => console.log(Object.keys(m)))"`

Expected: FAILS with:
```
Error [ERR_UNSUPPORTED_DIR_IMPORT]: Directory import '.../packages/env/src/packages' is not supported resolving ES modules imported from .../packages/env/src/index.ts
```

- [ ] **Step 2: Fix the three barrels**

`packages/env/src/index.ts`:
```ts
export * from './packages/index.ts'
export * from './shared/index.ts'
```

`packages/env/src/shared/index.ts`:
```ts
export * from './server.environment.ts'
```

`packages/env/src/packages/index.ts`:
```ts
export * from './cache.environment.ts'
export * from './database.environment.ts'
export * from './logger.environment.ts'
export * from './message-broker.environment.ts'
export * from './token-provider.environment.ts'
```

- [ ] **Step 3: Verify the fix under real Node**

Run: `node -e "import('./packages/env/src/index.ts').then(m => console.log(Object.keys(m)))"`

Expected: prints an array containing `cacheENV`, `databaseENV`, `loggerENV`, `messageBrokerENV`, `tokenProviderENV`, `EnvironmentEnum`, `serverENV` — no error.

- [ ] **Step 4: Verify nothing else broke**

Run: `pnpm --filter @ruguin/env test:unit`

Expected: PASS — all pre-existing tests unaffected (explicit extensions resolve identically under Vitest).

Run: `pnpm --filter @ruguin/env check:types`

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add packages/env/src/index.ts packages/env/src/shared/index.ts packages/env/src/packages/index.ts
git commit -m "fix(env): use explicit .ts extensions in barrel exports for Node ESM compatibility"
```

---

### Task 2: Add `docsENV` (`DOCS_USERNAME` / `DOCS_PASSWORD`)

**Files:**
- Create: `packages/env/src/packages/docs.environment.ts`
- Test: `packages/env/src/packages/__tests__/docs.environment.unit.ts`
- Modify: `packages/env/src/packages/index.ts`

**Interfaces:**
- Consumes: `createEnv` from `@t3-oss/env-core`, `z` from `zod` (both already dependencies of `@ruguin/env`).
- Produces: `docsENV: { DOCS_USERNAME: string; DOCS_PASSWORD: string }`, imported by Task 5 as `import { docsENV } from '@ruguin/env'`.

- [ ] **Step 1: Write the failing tests**

`packages/env/src/packages/__tests__/docs.environment.unit.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

const setEnvironment = (environment: Record<string, string>): void => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
}

describe('docsENV', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('parses the configured username and password', async () => {
    setEnvironment({ DOCS_USERNAME: 'admin', DOCS_PASSWORD: 'super-secret' })

    const { docsENV } = await import('../docs.environment')

    expect(docsENV.DOCS_USERNAME).toBe('admin')
    expect(docsENV.DOCS_PASSWORD).toBe('super-secret')
  })

  it('throws when DOCS_USERNAME is missing', async () => {
    setEnvironment({ DOCS_USERNAME: '', DOCS_PASSWORD: 'super-secret' })

    await expect(import('../docs.environment')).rejects.toThrow()
  })

  it('throws when DOCS_PASSWORD is missing', async () => {
    setEnvironment({ DOCS_USERNAME: 'admin', DOCS_PASSWORD: '' })

    await expect(import('../docs.environment')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @ruguin/env test:unit`

Expected: FAIL — `Cannot find module '../docs.environment'`.

- [ ] **Step 3: Implement**

`packages/env/src/packages/docs.environment.ts`:
```ts
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const docsENV = createEnv({
  server: {
    DOCS_USERNAME: z.string().min(1),
    DOCS_PASSWORD: z.string().min(1)
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true
})
```

`packages/env/src/packages/index.ts` (full file, keeping alphabetical order):
```ts
export * from './cache.environment.ts'
export * from './database.environment.ts'
export * from './docs.environment.ts'
export * from './logger.environment.ts'
export * from './message-broker.environment.ts'
export * from './token-provider.environment.ts'
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter @ruguin/env test:unit`

Expected: PASS — all `@ruguin/env` tests green, including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/env/src/packages/docs.environment.ts packages/env/src/packages/__tests__/docs.environment.unit.ts packages/env/src/packages/index.ts
git commit -m "feat(env): add docsENV (DOCS_USERNAME, DOCS_PASSWORD)"
```

---

### Task 3: Add new dependencies to `apps/core-server`

**Files:**
- Modify: `apps/core-server/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `@nestjs/swagger`, `@scalar/nestjs-api-reference`, `@fastify/basic-auth`, `@fastify/helmet`, `@fastify/compress`, `@ruguin/env` (workspace) resolvable from `apps/core-server` for Tasks 4–6.

- [ ] **Step 1: Add the dependencies**

In `apps/core-server/package.json`, add to `"dependencies"` (alongside the existing entries, alphabetically):
```json
    "@fastify/basic-auth": "6.2.0",
    "@fastify/compress": "9.1.0",
    "@fastify/helmet": "13.1.0",
    "@nestjs/swagger": "11.4.6",
    "@ruguin/env": "workspace:*",
    "@scalar/nestjs-api-reference": "1.2.11",
```

- [ ] **Step 2: Install**

Run: `pnpm install`

Expected: lockfile updates; no version-resolution or peer-dependency errors for the new Fastify plugins against the workspace's `fastify@5.10.0` (a transitive dependency of `@nestjs/platform-fastify`, already installed).

- [ ] **Step 3: Verify nothing broke**

Run: `pnpm --filter @ruguin/core-server test:all`

Expected: PASS — 4 test files, 8 tests (unchanged — no wiring added yet).

Run: `pnpm --filter @ruguin/core-server build`

Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/core-server/package.json pnpm-lock.yaml
git commit -m "chore(core-server): add Scalar, Swagger, Basic Auth, helmet and compress dependencies"
```

---

### Task 4: `configure-app.ts` — hardening (helmet, compress, URI versioning)

**Files:**
- Create: `apps/core-server/src/bootstrap/configure-app.ts`
- Test: `apps/core-server/src/bootstrap/__tests__/configure-app.e2e.ts`
- Modify: `apps/core-server/src/health/health.controller.ts`

**Interfaces:**
- Consumes: `NestFastifyApplication` type from `@nestjs/platform-fastify` (already a dependency); default export from `@fastify/helmet`; default export from `@fastify/compress`; `VersioningType` from `@nestjs/common` (already a dependency).
- Produces: `configureApp(app: NestFastifyApplication): Promise<void>`, extended in place by Task 5 and called by Task 6's `main.ts`. After this task, every route except `/health` resolves under `/v1/...` by default (`defaultVersion: '1'`).

- [ ] **Step 1: Write the failing e2e test**

`apps/core-server/src/bootstrap/__tests__/configure-app.e2e.ts`:
```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify'

import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../app.module'
import { configureApp } from '../configure-app'

describe('configureApp', () => {
  vi.stubEnv('DOCS_USERNAME', 'test-docs-user')
  vi.stubEnv('DOCS_PASSWORD', 'test-docs-pass')

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

  it('keeps /health version-neutral (no /v1 prefix)', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ status: 'ok' })
  })

  it('applies helmet security headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.headers['x-content-type-options']).toBe('nosniff')
  })
})
```

Note: `vi.stubEnv` calls for `DOCS_USERNAME`/`DOCS_PASSWORD` are already included here even though this task's `configureApp` doesn't read them yet — Task 5 extends this same file and needs them; adding them now avoids touching this setup twice.

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @ruguin/core-server test:e2e`

Expected: FAIL — `Cannot find module '../configure-app'`.

- [ ] **Step 3: Implement `configure-app.ts` (hardening only)**

`apps/core-server/src/bootstrap/configure-app.ts`:
```ts
import compress from '@fastify/compress'
import helmet from '@fastify/helmet'
import { VersioningType } from '@nestjs/common'
import { type NestFastifyApplication } from '@nestjs/platform-fastify'

export async function configureApp(app: NestFastifyApplication): Promise<void> {
  await app.register(helmet)
  await app.register(compress)

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
}
```

- [ ] **Step 4: Make `/health` version-neutral**

In `apps/core-server/src/health/health.controller.ts`, change:
```ts
import { Controller, Get } from '@nestjs/common'
```
to:
```ts
import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common'
```

and change:
```ts
@Controller('health')
```
to:
```ts
@Controller({ path: 'health', version: VERSION_NEUTRAL })
```

- [ ] **Step 5: Run it, verify it passes**

Run: `pnpm --filter @ruguin/core-server test:e2e`

Expected: PASS — both new tests in `configure-app.e2e.ts` green (2 tests).

Run: `pnpm --filter @ruguin/core-server test:all`

Expected: PASS — 5 test files, 10 tests total: the 3 pre-existing unit test files (7 tests: `pino-http-options.unit.ts` 3, `decorator-metadata.unit.ts` 1, `create-tracing-sdk.unit.ts` 3), the pre-existing `health.controller.e2e.ts` (1 test — it boots `AppModule` directly, never calling `configureApp`, so it's unaffected by this task), and the new `configure-app.e2e.ts` (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/core-server/src/bootstrap/configure-app.ts apps/core-server/src/bootstrap/__tests__/configure-app.e2e.ts apps/core-server/src/health/health.controller.ts
git commit -m "feat(core-server): add configureApp with helmet, compress, and URI versioning"
```

---

### Task 5: `configure-app.ts` — Scalar docs + Basic Auth

**Files:**
- Modify: `apps/core-server/src/bootstrap/configure-app.ts`
- Modify: `apps/core-server/src/bootstrap/__tests__/configure-app.e2e.ts`

**Interfaces:**
- Consumes: `docsENV` from `@ruguin/env` (Task 2); `DocumentBuilder`, `SwaggerModule` from `@nestjs/swagger`; `apiReference` from `@scalar/nestjs-api-reference`; default export from `@fastify/basic-auth`.
- Produces: `/docs` (Scalar UI) and `/docs-json` (raw OpenAPI document), both requiring HTTP Basic Auth validated against `docsENV.DOCS_USERNAME`/`DOCS_PASSWORD`. This completes `configureApp`, consumed as-is by Task 6.

- [ ] **Step 1: Extend the failing e2e tests**

Append these 4 `it` blocks inside the existing `describe('configureApp', ...)` block in `apps/core-server/src/bootstrap/__tests__/configure-app.e2e.ts`, right after the `'applies helmet security headers'` test:
```ts
  it('rejects /docs without credentials', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs' })

    expect(response.statusCode).toBe(401)
  })

  it('serves /docs with correct credentials', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs',
      headers: { authorization: `Basic ${Buffer.from('test-docs-user:test-docs-pass').toString('base64')}` }
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
      headers: { authorization: `Basic ${Buffer.from('test-docs-user:test-docs-pass').toString('base64')}` }
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ openapi: expect.any(String) })
  })
```

- [ ] **Step 2: Run it, verify the new tests fail**

Run: `pnpm --filter @ruguin/core-server test:e2e`

Expected: FAIL — `/docs` and `/docs-json` both return 404 (routes don't exist yet).

- [ ] **Step 3: Implement Scalar docs + Basic Auth**

Replace `apps/core-server/src/bootstrap/configure-app.ts` in full with:
```ts
import basicAuth from '@fastify/basic-auth'
import compress from '@fastify/compress'
import helmet from '@fastify/helmet'
import { VersioningType } from '@nestjs/common'
import { type NestFastifyApplication } from '@nestjs/platform-fastify'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { docsENV } from '@ruguin/env'
import { apiReference } from '@scalar/nestjs-api-reference'

export async function configureApp(app: NestFastifyApplication): Promise<void> {
  await app.register(helmet)
  await app.register(compress)

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })

  await app.register(basicAuth, {
    validate: async (username: string, password: string) => {
      if (username === docsENV.DOCS_USERNAME && password === docsENV.DOCS_PASSWORD) return
      throw new Error('Invalid credentials')
    },
    authenticate: true
  })

  const fastify = app.getHttpAdapter().getInstance()
  fastify.addHook('onRequest', (request, reply, done) => {
    if (!request.url.startsWith('/docs')) {
      done()
      return
    }
    fastify.basicAuth(request, reply, done)
  })

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Core Server API')
      .setDescription('API interna do core-server — health check e endpoints de negócio futuros.')
      .setVersion('0.0.1')
      .build()
  )

  app.use('/docs', apiReference({ withFastify: true, content: document }))
  app.getHttpAdapter().get('/docs-json', (_request, reply) => {
    reply.send(document)
  })
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter @ruguin/core-server test:e2e`

Expected: PASS — all 6 tests in `configure-app.e2e.ts` green.

Run: `pnpm --filter @ruguin/core-server test:all`

Expected: PASS — 5 test files, 14 tests total: the 3 pre-existing unit test files (7 tests, unchanged), `health.controller.e2e.ts` (1 test, unchanged), and `configure-app.e2e.ts` (now 6 tests: the 2 from Task 4 plus the 4 new ones).

Run: `pnpm --filter @ruguin/core-server check:types` and `pnpm --filter @ruguin/core-server check:lint`

Expected: 0 errors on both. If lint reports import-order issues, run `pnpm --filter @ruguin/core-server fix:lint` and re-check.

- [ ] **Step 5: Commit**

```bash
git add apps/core-server/src/bootstrap/configure-app.ts apps/core-server/src/bootstrap/__tests__/configure-app.e2e.ts
git commit -m "feat(core-server): add Scalar API docs at /docs, protected by Basic Auth"
```

---

### Task 6: Wire `configureApp` into `main.ts` + full verification

**Files:**
- Modify: `apps/core-server/src/main.ts`
- Modify: `apps/core-server/README.md`

**Interfaces:**
- Consumes: `configureApp` from `./bootstrap/configure-app` (Task 5).
- Produces: the fully wired `core-server` entrypoint — `/docs`, `/docs-json`, helmet, compress and URI versioning all active when the app actually boots via `pnpm start`. This is the task that proves Task 1's fix and Task 5's wiring work together under real Node, not only under Vitest.

- [ ] **Step 1: Wire it into `main.ts`**

Replace `apps/core-server/src/main.ts` in full with:
```ts
import { NestFactory } from '@nestjs/core'
import { type NestFastifyApplication } from '@nestjs/platform-fastify'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Logger } from 'nestjs-pino'

import { AppModule } from './app.module'
import { configureApp } from './bootstrap/configure-app'

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
  bufferLogs: true
})
app.useLogger(app.get(Logger))
await configureApp(app)
await app.listen(process.env.PORT ?? 3000, '0.0.0.0')
```

- [ ] **Step 2: Document the new required environment variables**

Replace `apps/core-server/README.md` in full with:
```markdown
# Core Server

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DOCS_USERNAME` | yes | Basic Auth username protecting `/docs` and `/docs-json`. Required in every environment — the app fails to boot without it. |
| `DOCS_PASSWORD` | yes | Basic Auth password protecting `/docs` and `/docs-json`. Required in every environment — the app fails to boot without it. |
| `PORT` | no (default `3000`) | HTTP port the app listens on. |
```

- [ ] **Step 3: Run the full test suite**

Run: `pnpm --filter @ruguin/core-server test:all`

Expected: PASS — 5 test files, 14 tests (same as end of Task 5 — `main.ts` isn't exercised directly by any test).

- [ ] **Step 4: Type-check and lint**

Run: `pnpm --filter @ruguin/core-server check:types`

Expected: 0 errors.

Run: `pnpm --filter @ruguin/core-server check:lint`

Expected: 0 errors/warnings.

- [ ] **Step 5: Build**

Run: `pnpm --filter @ruguin/core-server build`

Expected: succeeds, `dist/` contains no test files.

- [ ] **Step 6: Smoke-test the real entrypoint under Node**

This is the step that proves Task 1's fix actually matters: before it, this exact command would have crashed with `ERR_UNSUPPORTED_DIR_IMPORT` the moment `main.ts` reached `configureApp`'s `docsENV` import.

Run:
```bash
cd apps/core-server
DOCS_USERNAME=admin DOCS_PASSWORD=admin PORT=3999 timeout 5 node --import ./dist/tracing.js dist/main.js &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3999/health
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3999/docs
curl -s -o /dev/null -w "%{http_code}\n" -u admin:admin http://localhost:3999/docs
wait
```

Expected: three status codes printed — `200` (`/health`, no auth needed), `401` (`/docs` without credentials), `200` (`/docs` with correct credentials) — and no stack trace / crash in the process output.

- [ ] **Step 7: Full monorepo build + type-check**

Run: `pnpm build`

Expected: succeeds — `@ruguin/env`'s barrel fix (Task 1) and `@ruguin/core-server`'s new dependencies (Task 3) don't break any other workspace package.

Run: `pnpm check:types`

Expected: succeeds across all workspace packages.

- [ ] **Step 8: Commit**

```bash
git add apps/core-server/src/main.ts apps/core-server/README.md
git commit -m "feat(core-server): wire configureApp into the bootstrap entrypoint"
```
