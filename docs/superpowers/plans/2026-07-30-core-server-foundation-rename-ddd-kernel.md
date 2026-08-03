# Core Server Foundation — Rename + DDD Kernel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `apps/api-server` to `apps/core-server`, adopt the `__tests__/`-folder test convention (`.unit.ts`/`.int.ts`/`.e2e.ts`), and build `packages/shared-domain` (`BaseError`, `StatusError`, the `ID` value object) — the shared foundation that the DDD/hexagonal architecture in `docs/superpowers/specs/2026-07-29-core-server-architecture-design.md` is built on top of.

**Architecture:** Mechanical rename of the existing NestJS app first (proves nothing breaks), then a new dependency-free-except-`@ruguin/utils` package (`packages/shared-domain`) built test-first, one class at a time, mirroring the layout and conventions already used by `packages/utils`.

**Tech Stack:** TypeScript (strict), pnpm workspaces + Turborepo, Vitest, `uuid` (UUID v7), `@ruguin/utils` (`Either`/`Success`/`Failure`).

## Global Constraints

- TypeScript strict mode everywhere (`@ruguin/typescript-config/base.json`) — do not weaken compiler options.
- Every package/app is ESM (`"type": "module"`).
- Tests live in `__tests__/` folders, three suffixes: `.unit.ts` (no I/O, mock via `vitest-mock-extended` where applicable), `.int.ts` (real infra), `.e2e.ts` (full app). This plan only produces `.unit.ts` tests (`shared-domain` has no infra to integration-test) plus migrates the one existing `.e2e.ts`.
- Expected/domain failures use `Either`/`Success`/`Failure` from `@ruguin/utils` — never `throw` for domain errors.
- Every domain error class extends `BaseError` (`packages/shared-domain`) and sets `name` + `status` (`StatusError`).
- `packages/shared-domain` is "raw TS, no build" — same convention as `packages/utils`: `exports: { ".": "./src/index.ts" }`, no `dist/`, no `build` script.
- No `Co-Authored-By` trailer in commits (this project's `.claude/settings.json` does not set `attribution.commit`).
- Node `26.5.0`, pnpm `11.17.0` (pinned in root `package.json`).

---

### Task 1: Rename `apps/api-server` → `apps/core-server`

**Files:**
- Move: `apps/api-server/` → `apps/core-server/` (git mv, whole directory)
- Modify: `apps/core-server/package.json`
- Modify: `apps/core-server/src/tracing/create-tracing-sdk.ts`
- Move: `infrastructure/local/k6/api-server-health.ts` → `infrastructure/local/k6/core-server-health.ts`
- Modify: `package.json` (root)
- Modify: `docs/product-spec.md`

**Interfaces:**
- Consumes: nothing (pure rename, no new code).
- Produces: `apps/core-server` app, package name `@ruguin/core-server`, k6 script `core-server-health.ts` — every later task in this plan and in the follow-up Prisma/outbox plan targets this path and package name.

- [ ] **Step 1: Move the app directory**

```bash
git mv apps/api-server apps/core-server
```

- [ ] **Step 2: Rename the package**

In `apps/core-server/package.json`, change:

```json
  "name": "@ruguin/api-server",
```

to:

```json
  "name": "@ruguin/core-server",
```

- [ ] **Step 3: Rename the OTel service name**

In `apps/core-server/src/tracing/create-tracing-sdk.ts`, change:

```ts
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'api-server' }),
```

to:

```ts
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'core-server' }),
```

(No test asserts this literal today — `create-tracing-sdk.unit.ts` only covers `resolveOtlpEndpoint` and that `createTracingSdk` returns a `NodeSDK`. Nothing to update there.)

- [ ] **Step 4: Rename the k6 load-test script and its comment**

```bash
git mv infrastructure/local/k6/api-server-health.ts infrastructure/local/k6/core-server-health.ts
```

In the newly-moved file, change the header comment:

```ts
/*
 * Targets the api-server's Terminus health check. Run the api-server yourself first
 * (`pnpm --filter @ruguin/api-server start:dev`), then `pnpm infra:load-test:api-server`.
 * Override with K6_TARGET_URL to point at a different host/port.
 */
```

to:

```ts
/*
 * Targets the core-server's Terminus health check. Run the core-server yourself first
 * (`pnpm --filter @ruguin/core-server start:dev`), then `pnpm infra:load-test:core-server`.
 * Override with K6_TARGET_URL to point at a different host/port.
 */
```

- [ ] **Step 5: Rename the root package.json script**

In the root `package.json`, change:

```json
    "infra:load-test:api-server": "docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.tools.yml run --rm k6 run /scripts/api-server-health.ts",
```

to:

```json
    "infra:load-test:core-server": "docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.tools.yml run --rm k6 run /scripts/core-server-health.ts",
```

Keep the script's alphabetical position consistent with the rest of the `scripts` block (rename in place, don't move it).

- [ ] **Step 6: Update `docs/product-spec.md` path references**

Change line ~35:

```md
> **Nota de implementação:** a spec original especifica Fastify como framework HTTP do API Service. O código real em `apps/api-server` usa **NestJS** sobre o adapter `@nestjs/platform-fastify`, mantendo o alinhamento com a spec. Os imports relativos em `src/` são escritos sem extensão; um passo de pós-build (`scripts/fix-esm-imports.mjs`) reescreve o `dist/` compilado para incluir `.js`, que é o que o Node exige em ESM puro em runtime.
```

to (only the path changes):

```md
> **Nota de implementação:** a spec original especifica Fastify como framework HTTP do API Service. O código real em `apps/core-server` usa **NestJS** sobre o adapter `@nestjs/platform-fastify`, mantendo o alinhamento com a spec. Os imports relativos em `src/` são escritos sem extensão; um passo de pós-build (`scripts/fix-esm-imports.mjs`) reescreve o `dist/` compilado para incluir `.js`, que é o que o Node exige em ESM puro em runtime.
```

Change line ~37:

```md
Nenhum dos seis serviços tem nome de diretório fixado no monorepo ainda além de `apps/api-server`; `apps/dispatch-worker` e os demais nascem quando os tickets/planejamento correspondentes forem abertos.
```

to:

```md
Nenhum dos seis serviços tem nome de diretório fixado no monorepo ainda além de `apps/core-server`; `apps/dispatch-worker` e os demais nascem quando os tickets/planejamento correspondentes forem abertos.
```

**Do not** touch the `[Ticketado, api-server-hardening]` / `[Ticketado: EMAIL-3 / api-server-hardening]` tags elsewhere in the file (lines ~124, ~126, ~160) — those reference the historical spec filename `docs/superpowers/specs/2026-07-29-api-server-hardening-design.md`, which keeps its original name.

- [ ] **Step 7: Re-link the workspace**

```bash
pnpm install
```

Expected: pnpm updates the lockfile for the renamed package; no version resolution changes.

- [ ] **Step 8: Verify nothing broke**

```bash
pnpm --filter @ruguin/core-server test:all
pnpm --filter @ruguin/core-server build
```

Expected: same test results as before the rename (4 unit test files + 1 e2e test file, all passing); build succeeds.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: rename apps/api-server to apps/core-server"
```

---

### Task 2: Adopt the `__tests__/` + `.int.ts` test convention

**Files:**
- Move: `apps/core-server/src/decorator-metadata.unit.ts` → `apps/core-server/src/__tests__/decorator-metadata.unit.ts`
- Move: `apps/core-server/src/logger/pino-http-options.unit.ts` → `apps/core-server/src/logger/__tests__/pino-http-options.unit.ts`
- Move: `apps/core-server/src/tracing/create-tracing-sdk.unit.ts` → `apps/core-server/src/tracing/__tests__/create-tracing-sdk.unit.ts`
- Move: `apps/core-server/src/health/health.controller.e2e.ts` → `apps/core-server/src/health/__tests__/health.controller.e2e.ts`
- Modify: `apps/core-server/vitest.config.ts`
- Modify: `apps/core-server/nest-cli.json`

**Interfaces:**
- Consumes: `apps/core-server` from Task 1.
- Produces: every subsequent core-server feature (this plan doesn't add any — the follow-up Prisma/outbox plan does) writes tests under `src/**/__tests__/**/*.{unit,int,e2e}.ts`.

- [ ] **Step 1: Move the test files**

```bash
git mv apps/core-server/src/decorator-metadata.unit.ts apps/core-server/src/__tests__/decorator-metadata.unit.ts
git mv apps/core-server/src/logger/pino-http-options.unit.ts apps/core-server/src/logger/__tests__/pino-http-options.unit.ts
git mv apps/core-server/src/tracing/create-tracing-sdk.unit.ts apps/core-server/src/tracing/__tests__/create-tracing-sdk.unit.ts
git mv apps/core-server/src/health/health.controller.e2e.ts apps/core-server/src/health/__tests__/health.controller.e2e.ts
```

- [ ] **Step 2: Fix relative imports broken by the move**

`decorator-metadata.unit.ts` has no relative imports — nothing to fix.

In `apps/core-server/src/logger/__tests__/pino-http-options.unit.ts`, change:

```ts
import { createPinoHttpOptions } from './pino-http-options'
```

to:

```ts
import { createPinoHttpOptions } from '../pino-http-options'
```

In `apps/core-server/src/tracing/__tests__/create-tracing-sdk.unit.ts`, change:

```ts
import { createTracingSdk, resolveOtlpEndpoint } from './create-tracing-sdk'
```

to:

```ts
import { createTracingSdk, resolveOtlpEndpoint } from '../create-tracing-sdk'
```

In `apps/core-server/src/health/__tests__/health.controller.e2e.ts`, change:

```ts
import { AppModule } from '../app.module'
```

to:

```ts
import { AppModule } from '../../app.module'
```

- [ ] **Step 3: Update `vitest.config.ts` include globs**

In `apps/core-server/vitest.config.ts`, change the three `projects` entries:

```ts
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.unit.ts'],
          testTimeout: 5000
        }
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.integration.ts'],
          testTimeout: 15_000
        }
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['src/**/*.e2e.ts'],
          testTimeout: 30_000
        }
      }
    ]
```

to:

```ts
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/__tests__/**/*.unit.ts'],
          testTimeout: 5000
        }
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/__tests__/**/*.int.ts'],
          testTimeout: 15_000
        }
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['src/**/__tests__/**/*.e2e.ts'],
          testTimeout: 30_000
        }
      }
    ]
```

Note the project name stays `integration` (no script rename needed — `package.json`'s `test:integration` script still targets the `integration` project by name) even though the file suffix is now `.int.ts`.

- [ ] **Step 4: Update `nest-cli.json`'s build-ignore list**

In `apps/core-server/nest-cli.json`, change:

```json
        "ignore": ["**/*.spec.ts", "**/*.unit.ts", "**/*.e2e.ts", "**/*.integration.ts"]
```

to:

```json
        "ignore": ["**/*.spec.ts", "**/*.unit.ts", "**/*.e2e.ts", "**/*.int.ts"]
```

Without this change, `nest build` (SWC) would attempt to compile any future `.int.ts` file into `dist/` instead of skipping it like it already does for `.unit.ts`/`.e2e.ts`.

- [ ] **Step 5: Verify**

```bash
pnpm --filter @ruguin/core-server test:all
```

Expected: same 4 unit tests + 1 e2e test pass, now discovered via the new `__tests__/` globs.

```bash
pnpm --filter @ruguin/core-server build
```

Expected: succeeds, `dist/` contains no test files.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test(core-server): move tests into __tests__/ folders, adopt .int.ts suffix"
```

---

### Task 3: Scaffold `packages/shared-domain`

**Files:**
- Create: `packages/shared-domain/package.json`
- Create: `packages/shared-domain/tsconfig.json`
- Create: `packages/shared-domain/eslint.config.ts`
- Create: `packages/shared-domain/vitest.config.ts`
- Create: `packages/shared-domain/CLAUDE.md`
- Modify: `.cspell.json`

**Interfaces:**
- Consumes: `@ruguin/utils` (workspace, already published as `Either`/`success`/`failure` from `packages/utils/src/index.ts`).
- Produces: an installable, lintable, type-checkable, testable empty package `@ruguin/shared-domain` that Tasks 4–8 add source files to.

- [ ] **Step 1: Create `package.json`**

`packages/shared-domain/package.json`:

```json
{
  "name": "@ruguin/shared-domain",
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
    "@ruguin/utils": "workspace:*"
  },
  "devDependencies": {
    "@ruguin/eslint-config": "workspace:*",
    "@ruguin/typescript-config": "workspace:*",
    "@types/node": "^26.1.1",
    "npm-check-updates": "22.2.9",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

`packages/shared-domain/tsconfig.json`:

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

`packages/shared-domain/eslint.config.ts`:

```ts
import { defineConfig } from '@ruguin/eslint-config'

export default defineConfig({})
```

- [ ] **Step 4: Create `vitest.config.ts`**

`packages/shared-domain/vitest.config.ts`:

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

- [ ] **Step 5: Add the `uuid` dependency**

```bash
pnpm add uuid --filter @ruguin/shared-domain
```

Expected: `packages/shared-domain/package.json`'s `dependencies` gains a `"uuid": "^<resolved-version>"` entry, and the root lockfile updates.

- [ ] **Step 6: Link the workspace**

```bash
pnpm install
```

Expected: `@ruguin/shared-domain` now resolves `@ruguin/utils` via the workspace symlink.

- [ ] **Step 7: Allow-list the "ddd" word for spell-check**

In `.cspell.json`, insert `"ddd"` into the alphabetically-ordered `words` array right after `"dbgenerated"`:

```json
    "dabh",
    "dbgenerated",
    "ddd",
    "ddeeff",
    "debezium",
```

- [ ] **Step 8: Create `CLAUDE.md`**

`packages/shared-domain/CLAUDE.md`:

```markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

## Purpose

`@ruguin/shared-domain` — DDD building blocks shared across the monorepo's services (today only `core-server`, but meant for the future `dispatch-worker`, `tracking-service`, etc.): `BaseError`, `StatusError`, and generic value objects like `ID`. Depends on `@ruguin/utils` (for `Either`); no other package in the monorepo depends on this one in the other direction.

## Structure

\`\`\`text
src/
  enums/status-error.enum.ts   # semantic error categories, mapped to HTTP by the consumer
  errors/base-error.ts         # abstract class every domain error extends
  value-objects/id/
    id.value-object.ts         # ID (UUID v7); validate()/generate() return Either
    errors/                    # InvalidIDError, GenerateIDError
  index.ts                     # barrel export
\`\`\`

## Rules

- **No bounded-context-specific business logic.** Only generic primitives reusable by any service.
- **Raw TS, no build** — same convention as `@ruguin/utils`: exports `./src/index.ts` directly, no `dist/`.
- Every concrete error extends `BaseError` and implements `name`/`status`; every expected failure uses `Either`, never `throw`.

## Commands

\`\`\`bash
pnpm --filter @ruguin/shared-domain test:unit
pnpm --filter @ruguin/shared-domain check:types
\`\`\`
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore(shared-domain): scaffold package"
```

---

### Task 4: `StatusError` enum

**Files:**
- Create: `packages/shared-domain/src/enums/status-error.enum.ts`
- Create: `packages/shared-domain/src/enums/index.ts`
- Test: `packages/shared-domain/src/enums/__tests__/status-error.enum.unit.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `StatusError` enum with members `INVALID_INPUT | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | CONFLICT | UNPROCESSABLE | TOO_MANY_REQUESTS | INTERNAL_ERROR`, imported by Task 5 (`BaseError`) as `import { type StatusError } from '../enums'`.

- [ ] **Step 1: Write the failing test**

`packages/shared-domain/src/enums/__tests__/status-error.enum.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { StatusError } from '../status-error.enum'

describe('StatusError', () => {
  it('exposes one member per HTTP-mappable error category', () => {
    expect(StatusError.INVALID_INPUT).toBe('INVALID_INPUT')
    expect(StatusError.UNAUTHORIZED).toBe('UNAUTHORIZED')
    expect(StatusError.FORBIDDEN).toBe('FORBIDDEN')
    expect(StatusError.NOT_FOUND).toBe('NOT_FOUND')
    expect(StatusError.CONFLICT).toBe('CONFLICT')
    expect(StatusError.UNPROCESSABLE).toBe('UNPROCESSABLE')
    expect(StatusError.TOO_MANY_REQUESTS).toBe('TOO_MANY_REQUESTS')
    expect(StatusError.INTERNAL_ERROR).toBe('INTERNAL_ERROR')
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

```bash
pnpm --filter @ruguin/shared-domain test:unit
```

Expected: FAIL — `Cannot find module '../status-error.enum'`.

- [ ] **Step 3: Implement**

`packages/shared-domain/src/enums/status-error.enum.ts`:

```ts
export enum StatusError {
  INVALID_INPUT = 'INVALID_INPUT',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  UNPROCESSABLE = 'UNPROCESSABLE',
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',
  INTERNAL_ERROR = 'INTERNAL_ERROR'
}
```

`packages/shared-domain/src/enums/index.ts`:

```ts
export * from './status-error.enum'
```

- [ ] **Step 4: Run it, verify it passes**

```bash
pnpm --filter @ruguin/shared-domain test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(shared-domain): add StatusError enum"
```

---

### Task 5: `BaseError` abstract class

**Files:**
- Create: `packages/shared-domain/src/errors/base-error.ts`
- Create: `packages/shared-domain/src/errors/index.ts`
- Test: `packages/shared-domain/src/errors/__tests__/base-error.unit.ts`

**Interfaces:**
- Consumes: `StatusError` from Task 4 (`import { type StatusError } from '../enums'`).
- Produces: `BaseError` abstract class (`message: string`, `error?: unknown`, abstract `name: string`, abstract `status: StatusError`, `protected constructor(input: { message: string; error?: unknown })`), extended by every error class in Task 6 onward.

- [ ] **Step 1: Write the failing test**

`packages/shared-domain/src/errors/__tests__/base-error.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { StatusError } from '../../enums'
import { BaseError } from '../base-error'

class StubError extends BaseError {
  readonly name = 'StubError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { message: string; error?: unknown }) {
    super(input)
  }
}

describe('BaseError', () => {
  it('exposes message, name and status from the concrete subclass', () => {
    const error = new StubError({ message: 'something broke' })

    expect(error.message).toBe('something broke')
    expect(error.name).toBe('StubError')
    expect(error.status).toBe(StatusError.INTERNAL_ERROR)
    expect(error.error).toBeUndefined()
  })

  it('carries the original error when provided', () => {
    const original = new Error('root cause')
    const error = new StubError({ message: 'wrapped', error: original })

    expect(error.error).toBe(original)
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

```bash
pnpm --filter @ruguin/shared-domain test:unit
```

Expected: FAIL — `Cannot find module '../base-error'`.

- [ ] **Step 3: Implement**

`packages/shared-domain/src/errors/base-error.ts`:

```ts
import { type StatusError } from '../enums'

export abstract class BaseError {
  readonly error?: unknown
  readonly message: string
  abstract readonly name: string
  abstract readonly status: StatusError

  protected constructor(input: { message: string; error?: unknown }) {
    this.error = input.error
    this.message = input.message
  }
}
```

`packages/shared-domain/src/errors/index.ts`:

```ts
export * from './base-error'
```

- [ ] **Step 4: Run it, verify it passes**

```bash
pnpm --filter @ruguin/shared-domain test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(shared-domain): add BaseError abstract class"
```

---

### Task 6: `ID` value object errors — `InvalidIDError`, `GenerateIDError`

**Files:**
- Create: `packages/shared-domain/src/value-objects/id/errors/invalid-id.error.ts`
- Create: `packages/shared-domain/src/value-objects/id/errors/generate-id.error.ts`
- Create: `packages/shared-domain/src/value-objects/id/errors/index.ts`
- Test: `packages/shared-domain/src/value-objects/id/errors/__tests__/invalid-id.error.unit.ts`
- Test: `packages/shared-domain/src/value-objects/id/errors/__tests__/generate-id.error.unit.ts`

**Interfaces:**
- Consumes: `BaseError` (Task 5, `import { BaseError } from '../../../errors'`), `StatusError` (Task 4, `import { StatusError } from '../../../enums'`).
- Produces: `InvalidIDError` (`status: StatusError.INVALID_INPUT`, constructed with `{ id: string; modelName: string }` or `{ id: string; valueObjectName: string }`) and `GenerateIDError` (`status: StatusError.INTERNAL_ERROR`, constructed with `{ modelName: string; error: Error }` or `{ valueObjectName: string; error: Error }`) — both consumed by Task 7's `ID` value object.

- [ ] **Step 1: Write the failing tests**

`packages/shared-domain/src/value-objects/id/errors/__tests__/invalid-id.error.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { StatusError } from '../../../../enums'
import { InvalidIDError } from '../invalid-id.error'

describe('InvalidIDError', () => {
  it('builds the message from a modelName owner', () => {
    const error = new InvalidIDError({ id: 'not-a-uuid', modelName: 'Email' })

    expect(error.message).toBe('Invalid ID "not-a-uuid" for "Email"')
    expect(error.name).toBe('InvalidIDError')
    expect(error.status).toBe(StatusError.INVALID_INPUT)
  })

  it('builds the message from a valueObjectName owner', () => {
    const error = new InvalidIDError({ id: 'not-a-uuid', valueObjectName: 'ID' })

    expect(error.message).toBe('Invalid ID "not-a-uuid" for "ID"')
  })
})
```

`packages/shared-domain/src/value-objects/id/errors/__tests__/generate-id.error.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { StatusError } from '../../../../enums'
import { GenerateIDError } from '../generate-id.error'

describe('GenerateIDError', () => {
  it('builds the message from a modelName owner and carries the original error', () => {
    const original = new Error('crypto unavailable')
    const error = new GenerateIDError({ modelName: 'Email', error: original })

    expect(error.message).toBe('Failed to generate ID for "Email"')
    expect(error.name).toBe('GenerateIDError')
    expect(error.status).toBe(StatusError.INTERNAL_ERROR)
    expect(error.error).toBe(original)
  })

  it('builds the message from a valueObjectName owner', () => {
    const original = new Error('crypto unavailable')
    const error = new GenerateIDError({ valueObjectName: 'ID', error: original })

    expect(error.message).toBe('Failed to generate ID for "ID"')
  })
})
```

- [ ] **Step 2: Run them, verify they fail**

```bash
pnpm --filter @ruguin/shared-domain test:unit
```

Expected: FAIL — `Cannot find module '../invalid-id.error'` / `'../generate-id.error'`.

- [ ] **Step 3: Implement**

`packages/shared-domain/src/value-objects/id/errors/invalid-id.error.ts`:

```ts
import { BaseError } from '../../../errors'
import { StatusError } from '../../../enums'

type InvalidIDErrorInput = { id: string; modelName: string } | { id: string; valueObjectName: string }

export class InvalidIDError extends BaseError {
  readonly name = 'InvalidIDError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: InvalidIDErrorInput) {
    const owner = 'modelName' in input ? input.modelName : input.valueObjectName

    super({ message: `Invalid ID "${input.id}" for "${owner}"` })
  }
}
```

`packages/shared-domain/src/value-objects/id/errors/generate-id.error.ts`:

```ts
import { BaseError } from '../../../errors'
import { StatusError } from '../../../enums'

type GenerateIDErrorInput = { modelName: string; error: Error } | { valueObjectName: string; error: Error }

export class GenerateIDError extends BaseError {
  readonly name = 'GenerateIDError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: GenerateIDErrorInput) {
    const owner = 'modelName' in input ? input.modelName : input.valueObjectName

    super({ message: `Failed to generate ID for "${owner}"`, error: input.error })
  }
}
```

`packages/shared-domain/src/value-objects/id/errors/index.ts`:

```ts
export * from './generate-id.error'
export * from './invalid-id.error'
```

- [ ] **Step 4: Run them, verify they pass**

```bash
pnpm --filter @ruguin/shared-domain test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(shared-domain): add InvalidIDError and GenerateIDError"
```

---

### Task 7: `ID` value object

**Files:**
- Create: `packages/shared-domain/src/value-objects/id/id.value-object.ts`
- Create: `packages/shared-domain/src/value-objects/id/index.ts`
- Create: `packages/shared-domain/src/value-objects/index.ts`
- Test: `packages/shared-domain/src/value-objects/id/__tests__/id.value-object.unit.ts`
- Test: `packages/shared-domain/src/value-objects/id/__tests__/id.value-object.generate-error.unit.ts`

**Interfaces:**
- Consumes: `Either`/`success`/`failure` from `@ruguin/utils`; `InvalidIDError`, `GenerateIDError` from Task 6 (`import { GenerateIDError, InvalidIDError } from './errors'`); `v7 as uuidv7` from `uuid`.
- Produces: `ID` class — `ID.validate(input: { id: string; modelName: string } | { id: string; valueObjectName: string }): Either<InvalidIDError, { idValidated: ID }>`, `ID.generate(input: { modelName: string } | { valueObjectName: string }): Either<GenerateIDError, { idGenerated: ID }>`, instance methods `toString(): string`, `equals(input: { otherID: ID }): boolean`, `getPartition(input: { totalShards: number }): number`, readonly `value: string`. This is the type future bounded contexts (Plan 2 onward) use for every aggregate/entity identifier.

- [ ] **Step 1: Write the failing tests (main behavior)**

`packages/shared-domain/src/value-objects/id/__tests__/id.value-object.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { StatusError } from '../../../enums'
import { ID } from '../id.value-object'

const VALID_UUID_V7 = '018f4d2a-7c3b-7000-8abc-1234567890ab'

describe('ID.validate', () => {
  it('succeeds for a well-formed UUID v7', () => {
    const result = ID.validate({ id: VALID_UUID_V7, modelName: 'Email' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.idValidated.toString()).toBe(VALID_UUID_V7)
    }
  })

  it('fails with an InvalidIDError naming the modelName owner', () => {
    const result = ID.validate({ id: 'not-a-uuid', modelName: 'Email' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.message).toBe('Invalid ID "not-a-uuid" for "Email"')
      expect(result.value.status).toBe(StatusError.INVALID_INPUT)
    }
  })

  it('fails with an InvalidIDError naming the valueObjectName owner', () => {
    const result = ID.validate({ id: 'not-a-uuid', valueObjectName: 'ProjectID' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.message).toBe('Invalid ID "not-a-uuid" for "ProjectID"')
    }
  })

  it('trims surrounding whitespace before validating', () => {
    const result = ID.validate({ id: `  ${VALID_UUID_V7}  `, modelName: 'Email' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.idValidated.toString()).toBe(VALID_UUID_V7)
    }
  })
})

describe('ID.generate', () => {
  it('produces an ID that satisfies ID.validate', () => {
    const generated = ID.generate({ modelName: 'Email' })

    expect(generated.isSuccess()).toBe(true)
    if (generated.isSuccess()) {
      const validated = ID.validate({ id: generated.value.idGenerated.toString(), modelName: 'Email' })
      expect(validated.isSuccess()).toBe(true)
    }
  })
})

describe('ID#equals', () => {
  it('is true for the same value regardless of case', () => {
    const a = ID.validate({ id: VALID_UUID_V7, modelName: 'Email' })
    const b = ID.validate({ id: VALID_UUID_V7.toUpperCase(), modelName: 'Email' })

    if (a.isSuccess() && b.isSuccess()) {
      expect(a.value.idValidated.equals({ otherID: b.value.idValidated })).toBe(true)
    }
  })

  it('is false for a different value', () => {
    const a = ID.validate({ id: VALID_UUID_V7, modelName: 'Email' })
    const generated = ID.generate({ modelName: 'Email' })

    if (a.isSuccess() && generated.isSuccess()) {
      expect(a.value.idValidated.equals({ otherID: generated.value.idGenerated })).toBe(false)
    }
  })
})

describe('ID#getPartition', () => {
  it('is deterministic and within range for the same ID', () => {
    const result = ID.validate({ id: VALID_UUID_V7, modelName: 'Email' })

    if (result.isSuccess()) {
      const first = result.value.idValidated.getPartition({ totalShards: 4 })
      const second = result.value.idValidated.getPartition({ totalShards: 4 })

      expect(first).toBe(second)
      expect(first).toBeGreaterThanOrEqual(0)
      expect(first).toBeLessThan(4)
    }
  })
})
```

- [ ] **Step 2: Write the failing test (generator failure path)**

`packages/shared-domain/src/value-objects/id/__tests__/id.value-object.generate-error.unit.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { ID } from '../id.value-object'

vi.mock('uuid', () => ({
  v7: () => {
    throw new Error('crypto unavailable')
  }
}))

describe('ID.generate', () => {
  it('returns a GenerateIDError when the underlying UUID generator throws', () => {
    const result = ID.generate({ modelName: 'Email' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.name).toBe('GenerateIDError')
      expect(result.value.message).toBe('Failed to generate ID for "Email"')
      expect((result.value.error as Error).message).toBe('crypto unavailable')
    }
  })
})
```

(`vi.mock` calls are hoisted by Vitest to the top of the module regardless of where they're written, so this mock applies before `ID` imports `uuid` — this file gets its own isolated module registry per Vitest's default `pool`, so it does not affect `id.value-object.unit.ts`.)

- [ ] **Step 3: Run both, verify they fail**

```bash
pnpm --filter @ruguin/shared-domain test:unit
```

Expected: FAIL — `Cannot find module '../id.value-object'`.

- [ ] **Step 4: Implement**

`packages/shared-domain/src/value-objects/id/id.value-object.ts`:

```ts
import { type Either, failure, success } from '@ruguin/utils'
import { v7 as uuidv7 } from 'uuid'

import { GenerateIDError, InvalidIDError } from './errors'

export class ID {
  private static readonly UUID_V7_REGEX: RegExp =
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  public static validate(
    input: { id: string; modelName: string } | { id: string; valueObjectName: string }
  ): Either<InvalidIDError, { idValidated: ID }> {
    const id: string = input.id.trim()

    if (!this.UUID_V7_REGEX.test(id)) {
      return failure(
        new InvalidIDError({
          id,
          ...('modelName' in input ? { modelName: input.modelName } : { valueObjectName: input.valueObjectName })
        })
      )
    }

    const idValidated: ID = new ID({ id })

    return success({ idValidated })
  }

  public static generate(
    input: { modelName: string } | { valueObjectName: string }
  ): Either<GenerateIDError, { idGenerated: ID }> {
    try {
      const idGenerated: ID = new ID({ id: uuidv7() })

      return success({ idGenerated })
    } catch (error: unknown) {
      const normalizedError: Error = error instanceof Error ? error : new Error(String(error))

      return failure(
        new GenerateIDError({
          ...('modelName' in input ? { modelName: input.modelName } : { valueObjectName: input.valueObjectName }),
          error: normalizedError
        })
      )
    }
  }

  public readonly value: string

  private constructor(input: { id: string }) {
    this.value = input.id.trim()
    Object.freeze(this)
  }

  public toString(): string {
    return this.value
  }

  public equals(input: { otherID: ID }): boolean {
    if (!(input.otherID instanceof ID)) return false
    return this.value.toLowerCase() === input.otherID.value.toLowerCase()
  }

  public getPartition(input: { totalShards: number }): number {
    const timestamp: number = Number.parseInt(this.value.replaceAll('-', '').slice(0, 12), 16)
    return timestamp % input.totalShards
  }
}
```

`packages/shared-domain/src/value-objects/id/index.ts`:

```ts
export * from './errors'
export * from './id.value-object'
```

`packages/shared-domain/src/value-objects/index.ts`:

```ts
export * from './id'
```

- [ ] **Step 5: Run both, verify they pass**

```bash
pnpm --filter @ruguin/shared-domain test:unit
```

Expected: PASS — all tests across the package green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(shared-domain): add ID value object"
```

---

### Task 8: Public barrel export + full verification

**Files:**
- Create: `packages/shared-domain/src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–7.
- Produces: the package's public API — `import { BaseError, StatusError, ID, InvalidIDError, GenerateIDError } from '@ruguin/shared-domain'` — which the follow-up Prisma/transaction/outbox plan imports from.

- [ ] **Step 1: Create the top-level barrel**

`packages/shared-domain/src/index.ts`:

```ts
export * from './enums'
export * from './errors'
export * from './value-objects'
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter @ruguin/shared-domain check:types
```

Expected: 0 errors.

- [ ] **Step 3: Lint**

```bash
pnpm --filter @ruguin/shared-domain check:lint
```

Expected: 0 errors/warnings. If import ordering or similar auto-fixable issues are reported, run `pnpm --filter @ruguin/shared-domain fix:lint` and re-check.

- [ ] **Step 4: Run the full test suite**

```bash
pnpm --filter @ruguin/shared-domain test:all
```

Expected: PASS — `StatusError`, `BaseError`, `InvalidIDError`, `GenerateIDError`, `ID` (including the mocked-generator-failure test) all green.

- [ ] **Step 5: Spell-check**

```bash
pnpm check:spelling
```

Expected: 0 unknown-word errors (confirms the `.cspell.json` update from Task 3 covers everything new).

- [ ] **Step 6: Full monorepo build + type-check**

```bash
pnpm build
pnpm check:types
```

Expected: both succeed — `@ruguin/shared-domain` and `@ruguin/core-server` coexist cleanly alongside the rest of the workspace.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(shared-domain): add public barrel export"
```
