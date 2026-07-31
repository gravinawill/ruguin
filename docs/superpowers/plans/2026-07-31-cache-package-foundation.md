# `@ruguin/cache` — Fundação (Plano 1 de 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar `packages/cache` funcional com o driver `memory` — contratos de domínio, erros, serializer, key builder, resolver de versão de namespace, drivers `noop`/`memory` e os orquestradores de cache-aside e lock.

**Architecture:** Clean Architecture em três camadas. `domain/` só tem tipos, enums e erros (zero I/O). `application/` orquestra contratos do domínio e nunca conhece driver. `infra/` traz as implementações. Este plano cobre tudo exceto o driver Valkey (plano 2) e o adapter NestJS (plano 3).

**Tech Stack:** TypeScript 6.0.3, Vitest 4, zod 4.4.3, `@t3-oss/env-core` 0.13.11, pnpm workspaces, Turbo.

**Spec:** `docs/superpowers/specs/2026-07-31-cache-package-design.md`

## Global Constraints

- **TypeScript cru, sem build.** `packages/cache` exporta `./src/index.ts` diretamente. Nenhum `dist/`, nenhum script `build` — mesma convenção de `@ruguin/utils` e `@ruguin/ddd-kernel`.
- **Nenhuma exceção para falha esperada.** Todo caminho retorna `Either<F, S>` de `@ruguin/utils`. `throw` só para bug de programação.
- **Todo erro estende `BaseError`** de `@ruguin/ddd-kernel` e declara `readonly name` e `readonly status`.
- **`tsconfig` herda `@ruguin/typescript-config/base.json`**, que liga `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes` não. Acesso indexado devolve `T | undefined` — trate sempre.
- **Testes unitários:** `src/**/__tests__/**/*.unit.ts`. **Integração:** `src/**/__tests__/**/*.int.ts`.
- **Genéricos ficam no método**, nunca na interface — `ICacheProvider` não pode ter parâmetro de tipo.
- **Padrão de contrato:** um `export namespace <Nome>ProviderDTO` com `Input` / `OutputError` / `OutputSuccess` / `Output`, e um `export interface I<Nome>Provider` com um método só.
- **Import de `@ruguin/ddd-kernel` é pelo barrel** (`import { BaseError, StatusError } from '@ruguin/ddd-kernel'`) — a proibição de barrel documentada no CLAUDE.md daquele pacote vale apenas para imports internos dele.
- **Commits:** Conventional Commits, escopo `cache` (ou `env` na Task 1). **Nunca** adicionar trailer `Co-Authored-By`.

## File Structure

| Arquivo                                                            | Responsabilidade                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `packages/env/src/packages/cache.environment.ts`                   | Fonte única das variáveis `CACHE_*`                                   |
| `packages/cache/src/domain/enums/*.ts`                             | `CacheDriver`, `CacheConsistency`, `CacheHealthStatus`, `CacheSource` |
| `packages/cache/src/domain/errors/*.ts`                            | Sete erros, um arquivo cada                                           |
| `packages/cache/src/domain/contracts/**/*.ts`                      | Contratos granulares + `ICacheProvider` composto                      |
| `packages/cache/src/infra/serializers/json-serializer.strategy.ts` | Serialização JSON com `Either`                                        |
| `packages/cache/src/infra/key-builder.ts`                          | Validação e montagem da chave física                                  |
| `packages/cache/src/infra/namespace-version.resolver.ts`           | Cascata de consistência + memo local                                  |
| `packages/cache/src/infra/drivers/noop/noop-cache.provider.ts`     | Null Object                                                           |
| `packages/cache/src/infra/drivers/memory/*.ts`                     | Driver em processo, dividido por concern                              |
| `packages/cache/src/application/*.ts`                              | `getOrSet` e `executeWithLock`                                        |

---

### Task 1: Variáveis de ambiente do cache

**Files:**

- Modify: `packages/env/src/packages/cache.environment.ts`
- Test: `packages/env/src/packages/__tests__/cache.environment.unit.ts`

**Interfaces:**

- Consumes: nada.
- Produces: `cacheENV` com `CACHE_PREFIX: string`, `CACHE_DRIVER: 'valkey' | 'memory' | 'noop'`, `CACHE_MASTER_URL: string | undefined`, `CACHE_REPLICA_URLS: string[]`, `CACHE_DEFAULT_TTL_MS: number`, `CACHE_JITTER_RATIO: number`, `CACHE_NEGATIVE_TTL_MS: number`, `CACHE_NS_VERSION_LOCAL_TTL_MS: number`, `CACHE_DEFAULT_CONSISTENCY: 'eventual' | 'strong'`, `CACHE_INVALIDATION_BROADCAST: boolean`, `CACHE_OPERATION_TIMEOUT_MS: number`, `CACHE_BREAKER_FAILURE_THRESHOLD: number`, `CACHE_BREAKER_RESET_TIMEOUT_MS: number`, `CACHE_REPLICATION_LAG_THRESHOLD_BYTES: number`.

- [ ] **Step 1: Corrigir o teste que hoje afirma o contrário**

O caso existente usa `valkey` como exemplo de driver inválido. Em `packages/env/src/packages/__tests__/cache.environment.unit.ts`, substitua o bloco inteiro:

```ts
it('rejects an unknown driver instead of silently falling back', async () => {
  setEnvironment({ CACHE_PREFIX: 'ruguin:ledger', CACHE_DRIVER: 'redis' })

  await expect(import('../cache.environment')).rejects.toThrow()
})
```

- [ ] **Step 2: Escrever os testes que falham**

Adicione ao mesmo `describe`:

```ts
it('accepts the valkey driver when a master url is present', async () => {
  setEnvironment({
    CACHE_PREFIX: 'ruguin:iam',
    CACHE_DRIVER: 'valkey',
    CACHE_MASTER_URL: 'redis://localhost:6379'
  })

  const { cacheENV } = await import('../cache.environment')

  expect(cacheENV.CACHE_DRIVER).toBe('valkey')
  expect(cacheENV.CACHE_MASTER_URL).toBe('redis://localhost:6379')
})

it('rejects the valkey driver without a master url', async () => {
  setEnvironment({ CACHE_PREFIX: 'ruguin:iam', CACHE_DRIVER: 'valkey' })

  await expect(import('../cache.environment')).rejects.toThrow()
})

it('allows the memory driver without a master url', async () => {
  setEnvironment({ CACHE_PREFIX: 'ruguin:iam', CACHE_DRIVER: 'memory' })

  const { cacheENV } = await import('../cache.environment')

  expect(cacheENV.CACHE_MASTER_URL).toBeUndefined()
})

it('splits replica urls into a list and drops blanks', async () => {
  setEnvironment({
    CACHE_PREFIX: 'ruguin:iam',
    CACHE_REPLICA_URLS: 'redis://a:6379, redis://b:6379 ,'
  })

  const { cacheENV } = await import('../cache.environment')

  expect(cacheENV.CACHE_REPLICA_URLS).toEqual(['redis://a:6379', 'redis://b:6379'])
})

it('defaults replica urls to an empty list', async () => {
  setEnvironment({ CACHE_PREFIX: 'ruguin:iam' })

  const { cacheENV } = await import('../cache.environment')

  expect(cacheENV.CACHE_REPLICA_URLS).toEqual([])
})

it('applies the defaults for the consistency and resilience knobs', async () => {
  setEnvironment({ CACHE_PREFIX: 'ruguin:iam' })

  const { cacheENV } = await import('../cache.environment')

  expect(cacheENV.CACHE_DEFAULT_CONSISTENCY).toBe('eventual')
  expect(cacheENV.CACHE_INVALIDATION_BROADCAST).toBe(true)
  expect(cacheENV.CACHE_OPERATION_TIMEOUT_MS).toBe(500)
  expect(cacheENV.CACHE_BREAKER_FAILURE_THRESHOLD).toBe(5)
  expect(cacheENV.CACHE_BREAKER_RESET_TIMEOUT_MS).toBe(10_000)
  expect(cacheENV.CACHE_REPLICATION_LAG_THRESHOLD_BYTES).toBe(1_048_576)
})

it('accepts strong as the global consistency default', async () => {
  setEnvironment({ CACHE_PREFIX: 'ruguin:iam', CACHE_DEFAULT_CONSISTENCY: 'strong' })

  const { cacheENV } = await import('../cache.environment')

  expect(cacheENV.CACHE_DEFAULT_CONSISTENCY).toBe('strong')
})

it('turns the invalidation broadcast off from a string flag', async () => {
  setEnvironment({ CACHE_PREFIX: 'ruguin:iam', CACHE_INVALIDATION_BROADCAST: 'false' })

  const { cacheENV } = await import('../cache.environment')

  expect(cacheENV.CACHE_INVALIDATION_BROADCAST).toBe(false)
})
```

- [ ] **Step 3: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/env test:unit`
Expected: FAIL — `CACHE_DRIVER: 'valkey'` ainda é rejeitado e as variáveis novas não existem.

- [ ] **Step 4: Implementar**

Substitua `packages/env/src/packages/cache.environment.ts` por:

```ts
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const cacheENV = createEnv({
  server: {
    CACHE_PREFIX: z.string().min(1),
    CACHE_DRIVER: z.enum(['valkey', 'memory', 'noop']).default('memory'),
    CACHE_MASTER_URL: z.url().optional(),
    CACHE_REPLICA_URLS: z
      .string()
      .default('')
      .transform((urls) =>
        urls
          .split(',')
          .map((url) => url.trim())
          .filter((url) => url.length > 0)
      ),
    CACHE_DEFAULT_TTL_MS: z.coerce.number().int().positive().default(300_000),
    CACHE_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.1),
    CACHE_NEGATIVE_TTL_MS: z.coerce.number().int().positive().default(30_000),
    CACHE_NS_VERSION_LOCAL_TTL_MS: z.coerce.number().int().nonnegative().default(5000),
    CACHE_DEFAULT_CONSISTENCY: z.enum(['eventual', 'strong']).default('eventual'),
    CACHE_INVALIDATION_BROADCAST: z.stringbool().default(true),
    CACHE_OPERATION_TIMEOUT_MS: z.coerce.number().int().positive().default(500),
    CACHE_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
    CACHE_BREAKER_RESET_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    CACHE_REPLICATION_LAG_THRESHOLD_BYTES: z.coerce.number().int().nonnegative().default(1_048_576)
  },
  createFinalSchema: (shape) =>
    z
      .object(shape)
      .refine((environment) => environment.CACHE_DRIVER !== 'valkey' || environment.CACHE_MASTER_URL !== undefined, {
        message: 'CACHE_MASTER_URL is required when CACHE_DRIVER is "valkey"',
        path: ['CACHE_MASTER_URL']
      }),
  runtimeEnv: process.env,
  emptyStringAsUndefined: true
})
```

`createFinalSchema` recebe o shape completo e devolve o schema final — é o único ponto do `@t3-oss/env-core` com acesso a mais de um campo ao mesmo tempo, e por isso o único lugar onde a obrigatoriedade condicional de `CACHE_MASTER_URL` pode ser expressa.

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/env test:unit && pnpm --filter @ruguin/env check:types`
Expected: PASS nos dois.

- [ ] **Step 6: Atualizar a documentação do pacote**

Em `packages/env/CLAUDE.md`, na seção `## Dependencies`, nada muda. Nenhuma outra edição é necessária — o arquivo já lista `cache.environment.ts` na estrutura.

- [ ] **Step 7: Commit**

```bash
git add packages/env/src/packages/cache.environment.ts packages/env/src/packages/__tests__/cache.environment.unit.ts
git commit -m "feat(env): add valkey driver and cache connection variables"
```

---

### Task 2: Scaffold do pacote e enums de domínio

**Files:**

- Create: `packages/cache/package.json`, `packages/cache/tsconfig.json`, `packages/cache/vitest.config.ts`, `packages/cache/eslint.config.ts`
- Create: `packages/cache/src/domain/enums/cache-driver.enum.ts`, `cache-consistency.enum.ts`, `cache-health-status.enum.ts`, `cache-source.enum.ts`, `index.ts`
- Create: `packages/cache/src/domain/index.ts`, `packages/cache/src/index.ts`
- Test: `packages/cache/src/domain/enums/__tests__/cache-enums.unit.ts`

**Interfaces:**

- Consumes: nada.
- Produces: `CacheDriver`, `CacheConsistency`, `CacheHealthStatus`, `CacheSource` — cada um um objeto `as const` e um `type` homônimo, exportados pelo barrel raiz `@ruguin/cache`.

- [ ] **Step 1: Criar os arquivos de configuração**

`packages/cache/package.json`:

```json
{
  "name": "@ruguin/cache",
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
    "test:integration": "vitest run --project integration",
    "test:unit": "vitest run --project unit",
    "update:deps": "ncu -u"
  },
  "lint-staged": {
    "*.ts": "eslint --fix"
  },
  "dependencies": {
    "@ruguin/ddd-kernel": "workspace:*",
    "@ruguin/env": "workspace:*",
    "@ruguin/utils": "workspace:*"
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

`packages/cache/tsconfig.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "exclude": ["node_modules"],
  "extends": "@ruguin/typescript-config/base.json",
  "include": ["**/*.ts"]
}
```

`packages/cache/eslint.config.ts`:

```ts
import { defineConfig } from '@ruguin/eslint-config'

export default defineConfig()
```

`packages/cache/vitest.config.ts` — dois projetos desde já, para que o plano 2 não precise refazer:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    reporters: ['verbose'],
    passWithNoTests: true,
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
      }
    ]
  }
})
```

- [ ] **Step 2: Instalar as dependências do workspace**

Run: `pnpm install`
Expected: `packages/cache` aparece no workspace; `node_modules` criado dentro dele.

- [ ] **Step 3: Escrever o teste que falha**

`packages/cache/src/domain/enums/__tests__/cache-enums.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { CacheConsistency, CacheDriver, CacheHealthStatus, CacheSource } from '../index'

describe('cache enums', () => {
  it('lists every supported driver', () => {
    expect(Object.values(CacheDriver)).toEqual(['valkey', 'memory', 'noop'])
  })

  it('lists both consistency modes', () => {
    expect(Object.values(CacheConsistency)).toEqual(['eventual', 'strong'])
  })

  it('lists the three health statuses', () => {
    expect(Object.values(CacheHealthStatus)).toEqual(['healthy', 'degraded', 'unhealthy'])
  })

  it('distinguishes a cache hit from a loader result', () => {
    expect(CacheSource.CACHE).toBe('cache')
    expect(CacheSource.LOADER).toBe('loader')
  })
})
```

- [ ] **Step 4: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../index'`.

- [ ] **Step 5: Implementar os enums**

O monorepo evita `enum` do TypeScript (quebra sob ESM de Node, como já documentado no `ddd-kernel`). Use objeto `as const` mais `type` homônimo, exatamente como `StatusError`.

`packages/cache/src/domain/enums/cache-driver.enum.ts`:

```ts
export const CacheDriver = {
  VALKEY: 'valkey',
  MEMORY: 'memory',
  NOOP: 'noop'
} as const

export type CacheDriver = (typeof CacheDriver)[keyof typeof CacheDriver]
```

`packages/cache/src/domain/enums/cache-consistency.enum.ts`:

```ts
export const CacheConsistency = {
  EVENTUAL: 'eventual',
  STRONG: 'strong'
} as const

export type CacheConsistency = (typeof CacheConsistency)[keyof typeof CacheConsistency]
```

`packages/cache/src/domain/enums/cache-health-status.enum.ts`:

```ts
export const CacheHealthStatus = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy'
} as const

export type CacheHealthStatus = (typeof CacheHealthStatus)[keyof typeof CacheHealthStatus]
```

`packages/cache/src/domain/enums/cache-source.enum.ts`:

```ts
export const CacheSource = {
  CACHE: 'cache',
  LOADER: 'loader'
} as const

export type CacheSource = (typeof CacheSource)[keyof typeof CacheSource]
```

`packages/cache/src/domain/enums/index.ts`:

```ts
export * from './cache-consistency.enum'
export * from './cache-driver.enum'
export * from './cache-health-status.enum'
export * from './cache-source.enum'
```

`packages/cache/src/domain/index.ts`:

```ts
export * from './enums'
```

`packages/cache/src/index.ts`:

```ts
export * from './domain'
```

- [ ] **Step 6: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos três.

- [ ] **Step 7: Commit**

```bash
git add packages/cache pnpm-lock.yaml
git commit -m "feat(cache): scaffold package and add domain enums"
```

---

### Task 3: Erros de domínio

**Files:**

- Create: `packages/cache/src/domain/errors/cache-connection.error.ts`, `cache-timeout.error.ts`, `cache-serialization.error.ts`, `cache-not-initialized.error.ts`, `invalid-cache-key.error.ts`, `lock-not-acquired.error.ts`, `lock-not-owned.error.ts`, `cache-operation.error.ts`, `index.ts`
- Modify: `packages/cache/src/domain/index.ts`
- Test: `packages/cache/src/domain/errors/__tests__/cache-errors.unit.ts`

**Interfaces:**

- Consumes: `BaseError`, `StatusError` de `@ruguin/ddd-kernel`.
- Produces: sete classes mais o alias `CacheOperationError`. Construtores — `CacheConnectionError({ operation: string; error?: unknown })`, `CacheTimeoutError({ operation: string; timeoutInMs: number })`, `CacheSerializationError({ operation: string; error?: unknown })`, `CacheNotInitializedError({ operation: string })`, `InvalidCacheKeyError({ field: 'key' | 'namespace'; value: string; reason: string })`, `LockNotAcquiredError({ lockKey: string; attempts: number })`, `LockNotOwnedError({ lockKey: string })`.

- [ ] **Step 1: Escrever o teste que falha**

`packages/cache/src/domain/errors/__tests__/cache-errors.unit.ts`:

```ts
import { StatusError } from '@ruguin/ddd-kernel'
import { describe, expect, it } from 'vitest'

import {
  CacheConnectionError,
  CacheNotInitializedError,
  CacheSerializationError,
  CacheTimeoutError,
  InvalidCacheKeyError,
  LockNotAcquiredError,
  LockNotOwnedError
} from '../index'

describe('cache errors', () => {
  it('reports a connection failure as internal and keeps the original cause', () => {
    const cause = new Error('ECONNREFUSED')
    const error = new CacheConnectionError({ operation: 'get', error: cause })

    expect(error.name).toBe('CacheConnectionError')
    expect(error.status).toBe(StatusError.INTERNAL_ERROR)
    expect(error.message).toContain('get')
    expect(error.error).toBe(cause)
  })

  it('states the exceeded budget on a timeout', () => {
    const error = new CacheTimeoutError({ operation: 'set', timeoutInMs: 500 })

    expect(error.name).toBe('CacheTimeoutError')
    expect(error.status).toBe(StatusError.INTERNAL_ERROR)
    expect(error.message).toContain('500')
  })

  it('reports a serialization failure as internal', () => {
    const error = new CacheSerializationError({ operation: 'set' })

    expect(error.name).toBe('CacheSerializationError')
    expect(error.status).toBe(StatusError.INTERNAL_ERROR)
  })

  it('reports use before connect as internal', () => {
    const error = new CacheNotInitializedError({ operation: 'get' })

    expect(error.name).toBe('CacheNotInitializedError')
    expect(error.status).toBe(StatusError.INTERNAL_ERROR)
  })

  it('classifies an invalid key as bad input and names the offending field', () => {
    const error = new InvalidCacheKeyError({ field: 'namespace', value: 'has space', reason: 'contains whitespace' })

    expect(error.name).toBe('InvalidCacheKeyError')
    expect(error.status).toBe(StatusError.INVALID_INPUT)
    expect(error.message).toContain('namespace')
    expect(error.message).toContain('contains whitespace')
  })

  it('classifies a busy lock as a conflict', () => {
    const error = new LockNotAcquiredError({ lockKey: 'user:123', attempts: 3 })

    expect(error.name).toBe('LockNotAcquiredError')
    expect(error.status).toBe(StatusError.CONFLICT)
    expect(error.message).toContain('3')
  })

  it('classifies releasing a lock you no longer own as a conflict', () => {
    const error = new LockNotOwnedError({ lockKey: 'user:123' })

    expect(error.name).toBe('LockNotOwnedError')
    expect(error.status).toBe(StatusError.CONFLICT)
  })
})
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — módulo `../index` não existe.

- [ ] **Step 3: Implementar as sete classes**

```ts
// packages/cache/src/domain/errors/cache-connection.error.ts
import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class CacheConnectionError extends BaseError {
  readonly name = 'CacheConnectionError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { operation: string; error?: unknown }) {
    super({ message: `Cache connection failed during "${input.operation}"`, error: input.error })
  }
}
```

```ts
// packages/cache/src/domain/errors/cache-timeout.error.ts
import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class CacheTimeoutError extends BaseError {
  readonly name = 'CacheTimeoutError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { operation: string; timeoutInMs: number }) {
    super({ message: `Cache operation "${input.operation}" exceeded ${input.timeoutInMs}ms` })
  }
}
```

```ts
// packages/cache/src/domain/errors/cache-serialization.error.ts
import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class CacheSerializationError extends BaseError {
  readonly name = 'CacheSerializationError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { operation: string; error?: unknown }) {
    super({ message: `Cache serialization failed during "${input.operation}"`, error: input.error })
  }
}
```

```ts
// packages/cache/src/domain/errors/cache-not-initialized.error.ts
import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class CacheNotInitializedError extends BaseError {
  readonly name = 'CacheNotInitializedError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { operation: string }) {
    super({ message: `Cache used before connect() during "${input.operation}"` })
  }
}
```

```ts
// packages/cache/src/domain/errors/invalid-cache-key.error.ts
import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class InvalidCacheKeyError extends BaseError {
  readonly name = 'InvalidCacheKeyError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { field: 'key' | 'namespace' | 'version'; value: string; reason: string }) {
    super({ message: `Invalid cache ${input.field} "${input.value}": ${input.reason}` })
  }
}
```

```ts
// packages/cache/src/domain/errors/lock-not-acquired.error.ts
import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class LockNotAcquiredError extends BaseError {
  readonly name = 'LockNotAcquiredError'
  readonly status = StatusError.CONFLICT

  constructor(input: { lockKey: string; attempts: number }) {
    super({ message: `Lock "${input.lockKey}" not acquired after ${input.attempts} attempt(s)` })
  }
}
```

```ts
// packages/cache/src/domain/errors/lock-not-owned.error.ts
import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class LockNotOwnedError extends BaseError {
  readonly name = 'LockNotOwnedError'
  readonly status = StatusError.CONFLICT

  constructor(input: { lockKey: string }) {
    super({ message: `Lock "${input.lockKey}" is held by another owner or already expired` })
  }
}
```

Por fim, o alias que todo contrato folha usa. Toda operação pode falhar por conexão, timeout, uso antes do `connect()` ou chave inválida — repetir essa união em vinte e cinco contratos convidaria a esquecer um membro em algum deles, que é exatamente como um erro legítimo vira erro de compilação lá no driver.

```ts
// packages/cache/src/domain/errors/cache-operation.error.ts
import { type CacheConnectionError } from './cache-connection.error'
import { type CacheNotInitializedError } from './cache-not-initialized.error'
import { type CacheTimeoutError } from './cache-timeout.error'
import { type InvalidCacheKeyError } from './invalid-cache-key.error'

export type CacheOperationError =
  CacheConnectionError | CacheTimeoutError | CacheNotInitializedError | InvalidCacheKeyError
```

`packages/cache/src/domain/errors/index.ts`:

```ts
export * from './cache-connection.error'
export * from './cache-operation.error'
export * from './cache-not-initialized.error'
export * from './cache-serialization.error'
export * from './cache-timeout.error'
export * from './invalid-cache-key.error'
export * from './lock-not-acquired.error'
export * from './lock-not-owned.error'
```

Atualize `packages/cache/src/domain/index.ts`:

```ts
export * from './enums'
export * from './errors'
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos três.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src/domain
git commit -m "feat(cache): add domain errors"
```

---

### Task 4: Contratos de cache, contador e serializer

**Files:**

- Create: `packages/cache/src/domain/contracts/cache/{get,set,delete,set-if-not-exists,get-or-set}-cache.provider.ts`, `index.ts`
- Create: `packages/cache/src/domain/contracts/counter/{increment,decrement,get}-counter.provider.ts`, `index.ts`
- Create: `packages/cache/src/domain/contracts/serializer/serializer.strategy.ts`, `index.ts`
- Create: `packages/cache/src/domain/contracts/index.ts`
- Modify: `packages/cache/src/domain/index.ts`
- Test: `packages/cache/src/domain/contracts/__tests__/cache-contracts.unit.ts`

**Interfaces:**

- Consumes: `Either` de `@ruguin/utils`; `CacheConsistency`, `CacheSource` e os erros da Task 3.
- Produces:
  - `IGetCacheProvider.get<T>(input: { key: string; namespace: string; consistency?: CacheConsistency; validate?: (value: unknown) => boolean })`
  - `ISetCacheProvider.set<T>(input: { key: string; namespace: string; value: T; ttlInMs?: number; applyJitter?: boolean })`
  - `IDeleteCacheProvider.delete(input: { key: string; namespace: string })`
  - `ISetIfNotExistsCacheProvider.setIfNotExists<T>(input: { key: string; namespace: string; value: T; ttlInMs: number })`
  - `IGetOrSetCacheProvider.getOrSet<T, E>(input: { key; namespace; ttlInMs?; negativeTtlInMs?; consistency?; forceRefresh?; lock?; validate?; loader })`
  - `IIncrementCounterProvider.increment`, `IDecrementCounterProvider.decrement`, `IGetCounterProvider.getCounter`
  - `ISerializerStrategy.serialize<T>` / `deserialize<T>`

- [ ] **Step 1: Escrever o teste de conformidade que falha**

Contratos são só tipos, então o portão real é o `tsc`. O teste declara stubs que **têm** de satisfazer cada interface: se um DTO estiver malformado, `check:types` quebra.

`packages/cache/src/domain/contracts/__tests__/cache-contracts.unit.ts`:

```ts
import { type Either, failure, success } from '@ruguin/utils'
import { describe, expect, it } from 'vitest'

import { CacheSource } from '../../enums'
import {
  type GetCacheProviderDTO,
  type GetOrSetCacheProviderDTO,
  type IGetCacheProvider,
  type IGetOrSetCacheProvider,
  type IIncrementCounterProvider,
  type ISerializerStrategy,
  type ISetCacheProvider,
  type IncrementCounterProviderDTO,
  type SetCacheProviderDTO
} from '../index'

class StubProvider implements IGetCacheProvider, ISetCacheProvider, IIncrementCounterProvider, IGetOrSetCacheProvider {
  public async get<T>(_input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    return success({ found: false, value: null })
  }

  public async set<T>(_input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output {
    return success({ expiresAt: new Date(0) })
  }

  public async increment(_input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output {
    return success({ value: 1 })
  }

  public async getOrSet<T, E>(input: GetOrSetCacheProviderDTO.Input<T, E>): GetOrSetCacheProviderDTO.Output<T, E> {
    const loaded: Either<E, T | null> = await input.loader()
    if (loaded.isFailure()) return failure(loaded.value)
    return success({ value: loaded.value, source: CacheSource.LOADER })
  }
}

const jsonStub: ISerializerStrategy = {
  serialize: <T>(_input: { value: T }) => success({ serialized: '{}' }),
  deserialize: <T>(_input: { raw: string }) => success({ value: null as unknown as T })
}

describe('cache contracts', () => {
  it('lets one class satisfy several granular contracts at once', async () => {
    const provider = new StubProvider()
    const result = await provider.get<{ id: string }>({ key: 'a', namespace: 'user' })

    expect(result.isSuccess()).toBe(true)
  })

  it('reports the loader as the source when the cache is empty', async () => {
    const provider = new StubProvider()
    const result = await provider.getOrSet<number, Error>({
      key: 'a',
      namespace: 'user',
      loader: async () => success(42)
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.source).toBe(CacheSource.LOADER)
    expect(result.value.value).toBe(42)
  })

  it('exposes a serializer strategy shaped for Either', () => {
    const serialized = jsonStub.serialize({ value: { id: '1' } })

    expect(serialized.isSuccess()).toBe(true)
  })
})
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../index'`.

- [ ] **Step 3: Implementar os contratos de cache**

```ts
// packages/cache/src/domain/contracts/cache/get-cache.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheConsistency } from '../../enums'
import { type CacheOperationError, type CacheSerializationError } from '../../errors'

export namespace GetCacheProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    consistency?: CacheConsistency
    validate?: (value: unknown) => boolean
  }>

  export type OutputError = Readonly<CacheOperationError | CacheSerializationError>
  export type OutputSuccess<T> = Readonly<{ found: boolean; value: T | null }>

  export type Output<T> = Promise<Either<OutputError, OutputSuccess<T>>>
}

export interface IGetCacheProvider {
  get<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T>
}
```

`found` existe porque `value: null` sozinho é ambíguo: seria "não há chave" ou "há uma chave cujo valor é null"? Sem essa distinção o negative caching (§5.3) seria impossível — um `null` gravado de propósito, para não martelar o banco com uma chave inexistente, seria relido como miss e o banco seria consultado de novo. `found: false` é miss; `found: true, value: null` é a sentinela negativa.

```ts
// packages/cache/src/domain/contracts/cache/set-cache.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheOperationError, type CacheSerializationError } from '../../errors'

export namespace SetCacheProviderDTO {
  export type Input<T> = Readonly<{
    key: string
    namespace: string
    value: T
    ttlInMs?: number
    applyJitter?: boolean
  }>

  export type OutputError = Readonly<CacheOperationError | CacheSerializationError>
  export type OutputSuccess = Readonly<{ expiresAt: Date }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface ISetCacheProvider {
  set<T>(input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output
}
```

```ts
// packages/cache/src/domain/contracts/cache/delete-cache.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors'

export namespace DeleteCacheProviderDTO {
  export type Input = Readonly<{ key: string; namespace: string }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ existed: boolean }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IDeleteCacheProvider {
  delete(input: DeleteCacheProviderDTO.Input): DeleteCacheProviderDTO.Output
}
```

```ts
// packages/cache/src/domain/contracts/cache/set-if-not-exists-cache.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheOperationError, type CacheSerializationError } from '../../errors'

export namespace SetIfNotExistsCacheProviderDTO {
  export type Input<T> = Readonly<{
    key: string
    namespace: string
    value: T
    ttlInMs: number
  }>

  export type OutputError = Readonly<CacheOperationError | CacheSerializationError>
  export type OutputSuccess = Readonly<{ stored: boolean }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface ISetIfNotExistsCacheProvider {
  setIfNotExists<T>(input: SetIfNotExistsCacheProviderDTO.Input<T>): SetIfNotExistsCacheProviderDTO.Output
}
```

`stored: false` é a resposta de "a chave já existia" — o caso normal de idempotência, não uma falha.

```ts
// packages/cache/src/domain/contracts/cache/get-or-set-cache.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheConsistency, type CacheSource } from '../../enums'

export namespace GetOrSetCacheProviderDTO {
  export type Input<T, E> = Readonly<{
    key: string
    namespace: string
    ttlInMs?: number
    negativeTtlInMs?: number
    consistency?: CacheConsistency
    forceRefresh?: boolean
    lock?: Readonly<{ enabled: boolean; waitTimeoutInMs?: number }>
    validate?: (value: unknown) => boolean
    loader: () => Promise<Either<E, T | null>>
  }>

  export type OutputError<E> = Readonly<E>
  export type OutputSuccess<T> = Readonly<{ value: T | null; source: CacheSource }>

  export type Output<T, E> = Promise<Either<OutputError<E>, OutputSuccess<T>>>
}

export interface IGetOrSetCacheProvider {
  getOrSet<T, E>(input: GetOrSetCacheProviderDTO.Input<T, E>): GetOrSetCacheProviderDTO.Output<T, E>
}
```

Nenhum erro de cache aparece em `OutputError<E>`. Isso é intencional: o fail-open da spec §5.3 fica codificado no tipo, e o compilador impede que uma implementação futura propague `CacheConnectionError` daqui.

`packages/cache/src/domain/contracts/cache/index.ts`:

```ts
export * from './delete-cache.provider'
export * from './get-cache.provider'
export * from './get-or-set-cache.provider'
export * from './set-cache.provider'
export * from './set-if-not-exists-cache.provider'
```

- [ ] **Step 4: Implementar os contratos de contador**

```ts
// packages/cache/src/domain/contracts/counter/increment-counter.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors'

export namespace IncrementCounterProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    by?: number
    ttlInMs?: number
  }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ value: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IIncrementCounterProvider {
  increment(input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output
}
```

```ts
// packages/cache/src/domain/contracts/counter/decrement-counter.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors'

export namespace DecrementCounterProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    by?: number
  }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ value: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IDecrementCounterProvider {
  decrement(input: DecrementCounterProviderDTO.Input): DecrementCounterProviderDTO.Output
}
```

```ts
// packages/cache/src/domain/contracts/counter/get-counter.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors'

export namespace GetCounterProviderDTO {
  export type Input = Readonly<{ key: string; namespace: string }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ value: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IGetCounterProvider {
  getCounter(input: GetCounterProviderDTO.Input): GetCounterProviderDTO.Output
}
```

Contador ausente devolve `0`, não `null` — "nunca incrementado" e "zerado" são indistinguíveis para rate limiting, e um `number` puro evita que todo chamador trate `null`.

`packages/cache/src/domain/contracts/counter/index.ts`:

```ts
export * from './decrement-counter.provider'
export * from './get-counter.provider'
export * from './increment-counter.provider'
```

- [ ] **Step 5: Implementar o contrato do serializer**

```ts
// packages/cache/src/domain/contracts/serializer/serializer.strategy.ts
import { type Either } from '@ruguin/utils'

import { type CacheSerializationError } from '../../errors'

export namespace SerializerStrategyDTO {
  export type SerializeInput<T> = Readonly<{ value: T }>
  export type SerializeOutput = Either<CacheSerializationError, Readonly<{ serialized: string }>>

  export type DeserializeInput = Readonly<{ raw: string }>
  export type DeserializeOutput<T> = Either<CacheSerializationError, Readonly<{ value: T }>>
}

export interface ISerializerStrategy {
  serialize<T>(input: SerializerStrategyDTO.SerializeInput<T>): SerializerStrategyDTO.SerializeOutput
  deserialize<T>(input: SerializerStrategyDTO.DeserializeInput): SerializerStrategyDTO.DeserializeOutput<T>
}
```

O serializer é síncrono — é a única operação do pacote que não toca I/O, e envolvê-la em `Promise` obrigaria todo chamador a um `await` sem motivo.

`packages/cache/src/domain/contracts/serializer/index.ts`:

```ts
export * from './serializer.strategy'
```

`packages/cache/src/domain/contracts/index.ts`:

```ts
export * from './cache'
export * from './counter'
export * from './serializer'
```

Atualize `packages/cache/src/domain/index.ts`:

```ts
export * from './contracts'
export * from './enums'
export * from './errors'
```

- [ ] **Step 6: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos três. O `check:types` é o portão que de fato valida os contratos.

- [ ] **Step 7: Commit**

```bash
git add packages/cache/src/domain
git commit -m "feat(cache): add cache, counter and serializer contracts"
```

---

### Task 5: Contratos de lock e score

**Files:**

- Create: `packages/cache/src/domain/contracts/lock/{acquire,release,extend}-lock.provider.ts`, `execute-with-lock.provider.ts`, `index.ts`
- Create: `packages/cache/src/domain/contracts/score/{set,increment,get}-score.provider.ts`, `get-rank.provider.ts`, `get-top-scores.provider.ts`, `remove-score.provider.ts`, `count-scores.provider.ts`, `index.ts`
- Modify: `packages/cache/src/domain/contracts/index.ts`
- Test: `packages/cache/src/domain/contracts/__tests__/lock-and-score-contracts.unit.ts`

**Interfaces:**

- Consumes: `Either` de `@ruguin/utils`; erros da Task 3.
- Produces:
  - `IAcquireLockProvider.acquire(input: { key; namespace; ttlInMs: number; retry?: { attempts: number; delayInMs: number } })` → `{ token: string; expiresAt: Date }`
  - `IReleaseLockProvider.release(input: { key; namespace; token: string })` → `{ released: boolean }`
  - `IExtendLockProvider.extend(input: { key; namespace; token: string; ttlInMs: number })` → `{ expiresAt: Date }`
  - `IExecuteWithLockProvider.executeWithLock<T, E>(input: { key; namespace; ttlInMs; retry?; task: () => Promise<Either<E, T>> })`
  - `ISetScoreProvider.setScore`, `IIncrementScoreProvider.incrementScore`, `IGetScoreProvider.getScore`, `IGetRankProvider.getRank` → `{ rank: number | null; total: number }`, `IGetTopScoresProvider.getTopScores` → `{ entries: ReadonlyArray<{ member: string; score: number }> }`, `IRemoveScoreProvider.removeScore`, `ICountScoresProvider.countScores`

- [ ] **Step 1: Escrever o teste de conformidade que falha**

`packages/cache/src/domain/contracts/__tests__/lock-and-score-contracts.unit.ts`:

```ts
import { success } from '@ruguin/utils'
import { describe, expect, it } from 'vitest'

import {
  type AcquireLockProviderDTO,
  type GetRankProviderDTO,
  type GetTopScoresProviderDTO,
  type IAcquireLockProvider,
  type IGetRankProvider,
  type IGetTopScoresProvider,
  type IReleaseLockProvider,
  type ReleaseLockProviderDTO
} from '../index'

class StubLock implements IAcquireLockProvider, IReleaseLockProvider {
  public async acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    return success({ token: 'token-1', expiresAt: new Date(input.ttlInMs) })
  }

  public async release(_input: ReleaseLockProviderDTO.Input): ReleaseLockProviderDTO.Output {
    return success({ released: true })
  }
}

class StubScore implements IGetRankProvider, IGetTopScoresProvider {
  public async getRank(_input: GetRankProviderDTO.Input): GetRankProviderDTO.Output {
    return success({ rank: 11, total: 340 })
  }

  public async getTopScores(_input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output {
    return success({ entries: [{ member: 'a', score: 10 }] })
  }
}

describe('lock and score contracts', () => {
  it('requires an explicit ttl to acquire a lock', async () => {
    const lock = new StubLock()
    const result = await lock.acquire({ key: 'user:1', namespace: 'user', ttlInMs: 5000 })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.token).toBe('token-1')
  })

  it('requires the owner token to release a lock', async () => {
    const lock = new StubLock()
    const result = await lock.release({ key: 'user:1', namespace: 'user', token: 'token-1' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.released).toBe(true)
  })

  it('returns rank alongside the total so callers can render "11th of 340"', async () => {
    const score = new StubScore()
    const result = await score.getRank({ key: 'weekly', namespace: 'leaderboard', member: 'a' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value).toEqual({ rank: 11, total: 340 })
  })
})
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — os tipos de lock e score não existem no barrel.

- [ ] **Step 3: Implementar os contratos de lock**

```ts
// packages/cache/src/domain/contracts/lock/acquire-lock.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheOperationError, type LockNotAcquiredError } from '../../errors'

export namespace AcquireLockProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    ttlInMs: number
    retry?: Readonly<{ attempts: number; delayInMs: number }>
  }>

  export type OutputError = Readonly<CacheOperationError | LockNotAcquiredError>
  export type OutputSuccess = Readonly<{ token: string; expiresAt: Date }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IAcquireLockProvider {
  acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output
}
```

`ttlInMs` é obrigatório aqui, ao contrário do cache: chave sem TTL desperdiça memória, lock sem TTL é deadlock permanente se o dono morrer.

```ts
// packages/cache/src/domain/contracts/lock/release-lock.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheOperationError, type LockNotOwnedError } from '../../errors'

export namespace ReleaseLockProviderDTO {
  export type Input = Readonly<{ key: string; namespace: string; token: string }>

  export type OutputError = Readonly<CacheOperationError | LockNotOwnedError>
  export type OutputSuccess = Readonly<{ released: boolean }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IReleaseLockProvider {
  release(input: ReleaseLockProviderDTO.Input): ReleaseLockProviderDTO.Output
}
```

```ts
// packages/cache/src/domain/contracts/lock/extend-lock.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheOperationError, type LockNotOwnedError } from '../../errors'

export namespace ExtendLockProviderDTO {
  export type Input = Readonly<{ key: string; namespace: string; token: string; ttlInMs: number }>

  export type OutputError = Readonly<CacheOperationError | LockNotOwnedError>
  export type OutputSuccess = Readonly<{ expiresAt: Date }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IExtendLockProvider {
  extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output
}
```

```ts
// packages/cache/src/domain/contracts/lock/execute-with-lock.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheConnectionError, type LockNotAcquiredError } from '../../errors'

export namespace ExecuteWithLockProviderDTO {
  export type Input<T, E> = Readonly<{
    key: string
    namespace: string
    ttlInMs: number
    retry?: Readonly<{ attempts: number; delayInMs: number }>
    task: () => Promise<Either<E, T>>
  }>

  export type OutputError<E> = Readonly<E | LockNotAcquiredError | CacheConnectionError>
  export type OutputSuccess<T> = Readonly<{ value: T }>

  export type Output<T, E> = Promise<Either<OutputError<E>, OutputSuccess<T>>>
}

export interface IExecuteWithLockProvider {
  executeWithLock<T, E>(input: ExecuteWithLockProviderDTO.Input<T, E>): ExecuteWithLockProviderDTO.Output<T, E>
}
```

Diferente do `getOrSet`, aqui os erros de cache **aparecem** no tipo de falha. Não há fail-open possível: se o lock não foi obtido, executar a tarefa mesmo assim quebraria a exclusão mútua que o chamador pediu.

`packages/cache/src/domain/contracts/lock/index.ts`:

```ts
export * from './acquire-lock.provider'
export * from './execute-with-lock.provider'
export * from './extend-lock.provider'
export * from './release-lock.provider'
```

- [ ] **Step 4: Implementar os sete contratos de score**

Todos compartilham o mesmo tipo de erro. Crie cada arquivo:

```ts
// packages/cache/src/domain/contracts/score/set-score.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors'

export namespace SetScoreProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    member: string
    score: number
    ttlInMs?: number
  }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ created: boolean }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface ISetScoreProvider {
  setScore(input: SetScoreProviderDTO.Input): SetScoreProviderDTO.Output
}
```

```ts
// packages/cache/src/domain/contracts/score/increment-score.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors'

export namespace IncrementScoreProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    member: string
    by: number
    ttlInMs?: number
  }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ score: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IIncrementScoreProvider {
  incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output
}
```

```ts
// packages/cache/src/domain/contracts/score/get-score.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheConsistency } from '../../enums'
import { type CacheOperationError } from '../../errors'

export namespace GetScoreProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    member: string
    consistency?: CacheConsistency
  }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ score: number | null }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IGetScoreProvider {
  getScore(input: GetScoreProviderDTO.Input): GetScoreProviderDTO.Output
}
```

```ts
// packages/cache/src/domain/contracts/score/get-rank.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheConsistency } from '../../enums'
import { type CacheOperationError } from '../../errors'

export namespace GetRankProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    member: string
    consistency?: CacheConsistency
  }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ rank: number | null; total: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IGetRankProvider {
  getRank(input: GetRankProviderDTO.Input): GetRankProviderDTO.Output
}
```

`rank` é 1-based e `null` quando o membro não está no conjunto; `total` acompanha porque posição isolada raramente serve à interface.

```ts
// packages/cache/src/domain/contracts/score/get-top-scores.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheConsistency } from '../../enums'
import { type CacheOperationError } from '../../errors'

export namespace GetTopScoresProviderDTO {
  export type Entry = Readonly<{ member: string; score: number }>

  export type Input = Readonly<{
    key: string
    namespace: string
    limit: number
    offset?: number
    consistency?: CacheConsistency
  }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ entries: ReadonlyArray<Entry> }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IGetTopScoresProvider {
  getTopScores(input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output
}
```

```ts
// packages/cache/src/domain/contracts/score/remove-score.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors'

export namespace RemoveScoreProviderDTO {
  export type Input = Readonly<{ key: string; namespace: string; member: string }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ removed: boolean }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IRemoveScoreProvider {
  removeScore(input: RemoveScoreProviderDTO.Input): RemoveScoreProviderDTO.Output
}
```

```ts
// packages/cache/src/domain/contracts/score/count-scores.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheConsistency } from '../../enums'
import { type CacheOperationError } from '../../errors'

export namespace CountScoresProviderDTO {
  export type Input = Readonly<{ key: string; namespace: string; consistency?: CacheConsistency }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ total: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface ICountScoresProvider {
  countScores(input: CountScoresProviderDTO.Input): CountScoresProviderDTO.Output
}
```

`packages/cache/src/domain/contracts/score/index.ts`:

```ts
export * from './count-scores.provider'
export * from './get-rank.provider'
export * from './get-score.provider'
export * from './get-top-scores.provider'
export * from './increment-score.provider'
export * from './remove-score.provider'
export * from './set-score.provider'
```

Atualize `packages/cache/src/domain/contracts/index.ts`:

```ts
export * from './cache'
export * from './counter'
export * from './lock'
export * from './score'
export * from './serializer'
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos três.

- [ ] **Step 6: Commit**

```bash
git add packages/cache/src/domain
git commit -m "feat(cache): add lock and score contracts"
```

---

### Task 6: Contratos de namespace, conexão, health e o composto `ICacheProvider`

**Files:**

- Create: `packages/cache/src/domain/contracts/namespace/{invalidate-namespace,resolve-namespace-version}.provider.ts`, `index.ts`
- Create: `packages/cache/src/domain/contracts/connection/{connect,disconnect}.provider.ts`, `index.ts`
- Create: `packages/cache/src/domain/contracts/health/health-check.provider.ts`, `index.ts`
- Create: `packages/cache/src/domain/contracts/cache.provider.ts`
- Modify: `packages/cache/src/domain/contracts/index.ts`
- Test: `packages/cache/src/domain/contracts/__tests__/cache-provider-composite.unit.ts`

**Interfaces:**

- Consumes: todos os contratos das Tasks 4 e 5; `CacheDriver`, `CacheHealthStatus`.
- Produces:
  - `IInvalidateNamespaceProvider.invalidateNamespace(input: { namespace: string })` → `{ version: number }`
  - `IResolveNamespaceVersionProvider.resolveNamespaceVersion(input: { namespace: string; consistency?: CacheConsistency })` → `{ version: number }`
  - `IConnectProvider.connect()`, `IDisconnectProvider.disconnect()`
  - `IHealthCheckProvider.healthCheck(input?: { includeReplicas?: boolean; timeoutInMs?: number })` → o payload completo da spec §5.6
  - `ICacheDriver` — composição de todos os contratos **folha** (o que cada driver implementa)
  - `ICacheProvider extends ICacheDriver, IGetOrSetCacheProvider, IExecuteWithLockProvider` — o que o consumidor injeta

- [ ] **Step 1: Escrever o teste que falha**

`packages/cache/src/domain/contracts/__tests__/cache-provider-composite.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { type ICacheProvider, type IGetCacheProvider, type IHealthCheckProvider } from '../index'

describe('ICacheProvider', () => {
  it('is assignable to each granular contract it composes', () => {
    const assertGet = (_provider: IGetCacheProvider): void => undefined
    const assertHealth = (_provider: IHealthCheckProvider): void => undefined

    const asGranular = (provider: ICacheProvider): void => {
      assertGet(provider)
      assertHealth(provider)
    }

    expect(typeof asGranular).toBe('function')
  })
})
```

O teste é trivial em runtime de propósito: o valor está em `tsc` recusar compilar se `ICacheProvider` deixar de estender algum contrato.

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `ICacheProvider` e `IHealthCheckProvider` não existem.

- [ ] **Step 3: Implementar namespace e conexão**

```ts
// packages/cache/src/domain/contracts/namespace/invalidate-namespace.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors'

export namespace InvalidateNamespaceProviderDTO {
  export type Input = Readonly<{ namespace: string }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ version: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IInvalidateNamespaceProvider {
  invalidateNamespace(input: InvalidateNamespaceProviderDTO.Input): InvalidateNamespaceProviderDTO.Output
}
```

```ts
// packages/cache/src/domain/contracts/namespace/resolve-namespace-version.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheConsistency } from '../../enums'
import { type CacheOperationError } from '../../errors'

export namespace ResolveNamespaceVersionProviderDTO {
  export type Input = Readonly<{ namespace: string; consistency?: CacheConsistency }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ version: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IResolveNamespaceVersionProvider {
  resolveNamespaceVersion(input: ResolveNamespaceVersionProviderDTO.Input): ResolveNamespaceVersionProviderDTO.Output
}
```

```ts
// packages/cache/src/domain/contracts/connection/connect.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheConnectionError, type CacheTimeoutError } from '../../errors'

export namespace ConnectProviderDTO {
  export type OutputError = Readonly<CacheConnectionError | CacheTimeoutError>
  export type OutputSuccess = Readonly<{ connected: true }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IConnectProvider {
  connect(): ConnectProviderDTO.Output
}
```

```ts
// packages/cache/src/domain/contracts/connection/disconnect.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheConnectionError } from '../../errors'

export namespace DisconnectProviderDTO {
  export type OutputError = Readonly<CacheConnectionError>
  export type OutputSuccess = Readonly<{ disconnected: true }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IDisconnectProvider {
  disconnect(): DisconnectProviderDTO.Output
}
```

`connect` e `disconnect` não recebem `Input` — a configuração já veio pela factory, e aceitar parâmetros aqui abriria caminho para reconfigurar a conexão em runtime.

Os barrels `namespace/index.ts` e `connection/index.ts` reexportam seus arquivos, no mesmo padrão dos anteriores.

- [ ] **Step 4: Implementar o contrato de health**

```ts
// packages/cache/src/domain/contracts/health/health-check.provider.ts
import { type Either } from '@ruguin/utils'

import { type CacheDriver, type CacheHealthStatus } from '../../enums'
import { type CacheNotInitializedError } from '../../errors'

export namespace HealthCheckProviderDTO {
  export type NodeHealth = Readonly<{
    reachable: boolean
    latencyInMs: number
    role: string
    error?: string
  }>

  export type ReplicaHealth = Readonly<{
    host: string
    reachable: boolean
    latencyInMs: number
    replicationLagInBytes: number | null
    error?: string
  }>

  export type MemoryHealth = Readonly<{
    usedBytes: number
    maxBytes: number | null
    usedPercentage: number | null
    evictedKeys: number
  }>

  export type ClientsHealth = Readonly<{
    connected: number
    blocked: number
    rejectedTotal: number
  }>

  export type ServerInfo = Readonly<{
    version: string
    uptimeInSeconds: number
  }>

  export type Input = Readonly<{ includeReplicas?: boolean; timeoutInMs?: number }>

  export type OutputError = Readonly<CacheNotInitializedError>
  export type OutputSuccess = Readonly<{
    status: CacheHealthStatus
    driver: CacheDriver
    checkedAt: Date
    master: NodeHealth
    replicas: ReadonlyArray<ReplicaHealth>
    memory: MemoryHealth
    clients: ClientsHealth
    server: ServerInfo
  }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IHealthCheckProvider {
  healthCheck(input?: HealthCheckProviderDTO.Input): HealthCheckProviderDTO.Output
}
```

`OutputError` só admite `CacheNotInitializedError`. "Valkey fora do ar" é `status: 'unhealthy'` dentro de um `Success` — é a resposta que o `/health` precisa ler, não uma exceção a tratar.

- [ ] **Step 5: Implementar o composto**

```ts
// packages/cache/src/domain/contracts/cache.provider.ts
import {
  type IDeleteCacheProvider,
  type IGetCacheProvider,
  type IGetOrSetCacheProvider,
  type ISetCacheProvider,
  type ISetIfNotExistsCacheProvider
} from './cache'
import { type IConnectProvider, type IDisconnectProvider } from './connection'
import { type IDecrementCounterProvider, type IGetCounterProvider, type IIncrementCounterProvider } from './counter'
import { type IHealthCheckProvider } from './health'
import {
  type IAcquireLockProvider,
  type IExecuteWithLockProvider,
  type IExtendLockProvider,
  type IReleaseLockProvider
} from './lock'
import { type IInvalidateNamespaceProvider, type IResolveNamespaceVersionProvider } from './namespace'
import {
  type ICountScoresProvider,
  type IGetRankProvider,
  type IGetScoreProvider,
  type IGetTopScoresProvider,
  type IIncrementScoreProvider,
  type IRemoveScoreProvider,
  type ISetScoreProvider
} from './score'

/*
 * Split on purpose. A driver adapts one storage technology and implements only the leaf
 * operations. getOrSet and executeWithLock are orchestration built on those leaves — they
 * are identical for every driver, so they live in application/ and are composed in once,
 * rather than being reimplemented by valkey, memory and noop alike.
 */
export interface ICacheDriver
  extends
    IGetCacheProvider,
    ISetCacheProvider,
    IDeleteCacheProvider,
    ISetIfNotExistsCacheProvider,
    IIncrementCounterProvider,
    IDecrementCounterProvider,
    IGetCounterProvider,
    IAcquireLockProvider,
    IReleaseLockProvider,
    IExtendLockProvider,
    ISetScoreProvider,
    IIncrementScoreProvider,
    IGetScoreProvider,
    IGetRankProvider,
    IGetTopScoresProvider,
    IRemoveScoreProvider,
    ICountScoresProvider,
    IInvalidateNamespaceProvider,
    IResolveNamespaceVersionProvider,
    IConnectProvider,
    IDisconnectProvider,
    IHealthCheckProvider {}

export interface ICacheProvider extends ICacheDriver, IGetOrSetCacheProvider, IExecuteWithLockProvider {}
```

`ICacheProvider` continua sendo o "tudo num objeto só" que o consumidor injeta. `ICacheDriver` é o que cada driver precisa implementar — e é por isso que adicionar um driver novo não custa reescrever cache-aside.

Atualize `packages/cache/src/domain/contracts/index.ts`:

```ts
export * from './cache'
export * from './cache.provider'
export * from './connection'
export * from './counter'
export * from './health'
export * from './lock'
export * from './namespace'
export * from './score'
export * from './serializer'
```

- [ ] **Step 6: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos três.

- [ ] **Step 7: Commit**

```bash
git add packages/cache/src/domain
git commit -m "feat(cache): add namespace, connection and health contracts plus ICacheProvider"
```

---

### Task 7: `JsonSerializerStrategy`

**Files:**

- Create: `packages/cache/src/infra/serializers/json-serializer.strategy.ts`, `index.ts`
- Create: `packages/cache/src/infra/index.ts`
- Modify: `packages/cache/src/index.ts`
- Test: `packages/cache/src/infra/serializers/__tests__/json-serializer.strategy.unit.ts`

**Interfaces:**

- Consumes: `ISerializerStrategy`, `CacheSerializationError`.
- Produces: `class JsonSerializerStrategy implements ISerializerStrategy` — construtor sem argumentos.

- [ ] **Step 1: Escrever o teste que falha**

`packages/cache/src/infra/serializers/__tests__/json-serializer.strategy.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { CacheSerializationError } from '../../../domain'
import { JsonSerializerStrategy } from '../json-serializer.strategy'

describe('JsonSerializerStrategy', () => {
  const serializer = new JsonSerializerStrategy()

  it('round-trips an object', () => {
    const serialized = serializer.serialize({ value: { id: '1', tags: ['a'] } })

    if (serialized.isFailure()) throw new Error('expected success')

    const deserialized = serializer.deserialize<{ id: string; tags: string[] }>({
      raw: serialized.value.serialized
    })

    if (deserialized.isFailure()) throw new Error('expected success')
    expect(deserialized.value.value).toEqual({ id: '1', tags: ['a'] })
  })

  it('round-trips null without confusing it with a failure', () => {
    const serialized = serializer.serialize({ value: null })

    if (serialized.isFailure()) throw new Error('expected success')
    expect(serialized.value.serialized).toBe('null')

    const deserialized = serializer.deserialize<null>({ raw: 'null' })

    if (deserialized.isFailure()) throw new Error('expected success')
    expect(deserialized.value.value).toBeNull()
  })

  it('fails on a circular structure instead of throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    const result = serializer.serialize({ value: circular })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBeInstanceOf(CacheSerializationError)
  })

  it('fails on malformed json instead of throwing', () => {
    const result = serializer.deserialize<unknown>({ raw: '{not json' })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBeInstanceOf(CacheSerializationError)
  })

  it('fails when the value is undefined, which JSON cannot represent', () => {
    const result = serializer.serialize({ value: undefined })

    expect(result.isFailure()).toBe(true)
  })
})
```

O caso `undefined` é o que separa este serializer de um `JSON.stringify` ingênuo: `JSON.stringify(undefined)` devolve `undefined` — não uma string — e gravar isso no cache produziria uma chave corrompida silenciosamente.

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../json-serializer.strategy'`.

- [ ] **Step 3: Implementar**

```ts
// packages/cache/src/infra/serializers/json-serializer.strategy.ts
import { type Either, failure, success } from '@ruguin/utils'

import { CacheSerializationError, type ISerializerStrategy, type SerializerStrategyDTO } from '../../domain'

export class JsonSerializerStrategy implements ISerializerStrategy {
  public serialize<T>(input: SerializerStrategyDTO.SerializeInput<T>): SerializerStrategyDTO.SerializeOutput {
    try {
      const serialized: string | undefined = JSON.stringify(input.value)

      if (serialized === undefined) {
        return failure(
          new CacheSerializationError({
            operation: 'serialize',
            error: new Error('value is not representable in JSON')
          })
        )
      }

      return success({ serialized })
    } catch (error: unknown) {
      return failure(new CacheSerializationError({ operation: 'serialize', error }))
    }
  }

  public deserialize<T>(input: SerializerStrategyDTO.DeserializeInput): SerializerStrategyDTO.DeserializeOutput<T> {
    try {
      const value: T = JSON.parse(input.raw) as T

      return success({ value })
    } catch (error: unknown) {
      return failure(new CacheSerializationError({ operation: 'deserialize', error }))
    }
  }
}
```

`packages/cache/src/infra/serializers/index.ts`:

```ts
export * from './json-serializer.strategy'
```

`packages/cache/src/infra/index.ts`:

```ts
export * from './serializers'
```

Atualize `packages/cache/src/index.ts`:

```ts
export * from './domain'
export * from './infra'
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos três.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src
git commit -m "feat(cache): add json serializer strategy"
```

---

### Task 8: `key-builder`

**Files:**

- Create: `packages/cache/src/infra/key-builder.ts`
- Modify: `packages/cache/src/infra/index.ts`
- Test: `packages/cache/src/infra/__tests__/key-builder.unit.ts`

**Interfaces:**

- Consumes: `InvalidCacheKeyError`.
- Produces:
  - `class KeyBuilder` — `new KeyBuilder({ prefix: string })`
  - `.build(input: { namespace: string; version: number; key: string }): Either<InvalidCacheKeyError, { physicalKey: string }>`
  - `.buildVersionKey(input: { namespace: string }): Either<InvalidCacheKeyError, { physicalKey: string }>`
  - `.buildLockKey(input: { namespace: string; key: string }): Either<InvalidCacheKeyError, { physicalKey: string }>`

- [ ] **Step 1: Escrever o teste que falha**

`packages/cache/src/infra/__tests__/key-builder.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { InvalidCacheKeyError } from '../../domain'
import { KeyBuilder } from '../key-builder'

describe('KeyBuilder', () => {
  const builder = new KeyBuilder({ prefix: 'ruguin:iam' })

  it('assembles prefix, namespace, version and key', () => {
    const result = builder.build({ namespace: 'user', version: 7, key: '123' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.physicalKey).toBe('ruguin:iam:user:v7:123')
  })

  it('builds the version key for a namespace', () => {
    const result = builder.buildVersionKey({ namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.physicalKey).toBe('ruguin:iam:user:__version__')
  })

  it('builds a lock key that cannot collide with a value key', () => {
    const result = builder.buildLockKey({ namespace: 'user', key: '123' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.physicalKey).toBe('ruguin:iam:user:__lock__:123')
  })

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['with a space', 'a b'],
    ['with a newline', 'a\nb'],
    ['with a colon', 'a:b']
  ])('rejects a key that is %s', (_label, key) => {
    const result = builder.build({ namespace: 'user', version: 1, key })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBeInstanceOf(InvalidCacheKeyError)
    expect(result.value.message).toContain('key')
  })

  it('rejects an invalid namespace and names that field', () => {
    const result = builder.build({ namespace: 'bad namespace', version: 1, key: '123' })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value.message).toContain('namespace')
  })

  it('rejects a non-positive version and blames the version, not the namespace', () => {
    const result = builder.build({ namespace: 'user', version: 0, key: '123' })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value.message).toContain('version')
    expect(result.value.message).not.toContain('namespace')
  })
})
```

O `:` é proibido na `key` porque é o separador da chave física — permiti-lo deixaria `build({ namespace: 'user', key: 'a:b' })` colidir com uma chave de outro namespace.

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../key-builder'`.

- [ ] **Step 3: Implementar**

```ts
// packages/cache/src/infra/key-builder.ts
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidCacheKeyError } from '../domain'

type BuildOutput = Either<InvalidCacheKeyError, Readonly<{ physicalKey: string }>>

export class KeyBuilder {
  private static readonly FORBIDDEN: RegExp = /[\s:]/
  private static readonly VERSION_SUFFIX: string = '__version__'
  private static readonly LOCK_SEGMENT: string = '__lock__'

  private readonly prefix: string

  constructor(input: { prefix: string }) {
    this.prefix = input.prefix
  }

  public build(input: { namespace: string; version: number; key: string }): BuildOutput {
    const validated = this.validate({ namespace: input.namespace, key: input.key })
    if (validated.isFailure()) return failure(validated.value)

    if (!Number.isInteger(input.version) || input.version < 1) {
      return failure(
        new InvalidCacheKeyError({
          field: 'version',
          value: String(input.version),
          reason: 'must be a positive integer'
        })
      )
    }

    return success({
      physicalKey: `${this.prefix}:${input.namespace}:v${input.version}:${input.key}`
    })
  }

  public buildVersionKey(input: { namespace: string }): BuildOutput {
    const validated = this.validateSegment({ field: 'namespace', value: input.namespace })
    if (validated.isFailure()) return failure(validated.value)

    return success({ physicalKey: `${this.prefix}:${input.namespace}:${KeyBuilder.VERSION_SUFFIX}` })
  }

  public buildLockKey(input: { namespace: string; key: string }): BuildOutput {
    const validated = this.validate({ namespace: input.namespace, key: input.key })
    if (validated.isFailure()) return failure(validated.value)

    return success({
      physicalKey: `${this.prefix}:${input.namespace}:${KeyBuilder.LOCK_SEGMENT}:${input.key}`
    })
  }

  private validate(input: { namespace: string; key: string }): Either<InvalidCacheKeyError, true> {
    const namespaceResult = this.validateSegment({ field: 'namespace', value: input.namespace })
    if (namespaceResult.isFailure()) return failure(namespaceResult.value)

    return this.validateSegment({ field: 'key', value: input.key })
  }

  private validateSegment(input: { field: 'key' | 'namespace'; value: string }): Either<InvalidCacheKeyError, true> {
    if (input.value.trim().length === 0) {
      return failure(new InvalidCacheKeyError({ field: input.field, value: input.value, reason: 'must not be blank' }))
    }

    if (KeyBuilder.FORBIDDEN.test(input.value)) {
      return failure(
        new InvalidCacheKeyError({
          field: input.field,
          value: input.value,
          reason: 'must not contain whitespace or ":"'
        })
      )
    }

    return success(true)
  }
}
```

Atualize `packages/cache/src/infra/index.ts`:

```ts
export * from './key-builder'
export * from './serializers'
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos três.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src/infra
git commit -m "feat(cache): add key builder with namespace and key validation"
```

---

### Task 9: `NamespaceVersionResolver` — cascata de consistência e memo local

**Files:**

- Create: `packages/cache/src/infra/namespace-version.resolver.ts`
- Modify: `packages/cache/src/infra/index.ts`
- Test: `packages/cache/src/infra/__tests__/namespace-version.resolver.unit.ts`

**Interfaces:**

- Consumes: `IResolveNamespaceVersionProvider`, `CacheConsistency`, `CacheConnectionError`.
- Produces:
  - `type NamespaceVersionSource = { fetchVersion: (input: { namespace: string; consistency: CacheConsistency }) => Promise<Either<CacheConnectionError, { version: number }>> }`
  - `type NamespaceConfig = Readonly<Record<string, Readonly<{ consistency?: CacheConsistency }>>>`
  - `class NamespaceVersionResolver implements IResolveNamespaceVersionProvider` — `new NamespaceVersionResolver({ source, defaultConsistency, localTtlInMs, namespaces })`
  - `.resolveNamespaceVersion(input)` — o contrato
  - `.applyBroadcast(input: { namespace: string; version: number }): void` — chamada pelo subscriber (plano 2)
  - `.clearMemo(): void` — chamada na reconexão do subscriber (plano 2)

Este é o componente que a spec §4 inteira descreve. Ele não conhece Valkey: recebe a busca de versão como porta, o que o torna testável sem I/O e reutilizável por qualquer driver.

**Contrato para o plano 2:** o resolver devolve `failure` quando a resolução falha em modo `strong`, mas isso é sinal **interno**. A spec §4.4 exige que a _operação_ devolva **miss**, não falha — então o driver Valkey, ao receber esse `failure`, deve traduzir para `success({ found: false, value: null })` na `get` e nas leituras de score. Assim o `getOrSet` cai no `loader` e quem chama `get()` direto vê um miss honesto, em vez de um erro que sugere indisponibilidade.

**Quem consome:** o driver Valkey, no plano 2 — é lá que resolver a versão custa um round-trip e o memo se paga. O driver `memory` (Task 12) lê `store.getVersion()` direto, porque memoizar um acesso a `Map` na frente de outro acesso a `Map` seria indireção sem ganho. Construí-lo agora, isolado e testado, é o que permite ao plano 2 focar em I/O.

- [ ] **Step 1: Escrever o teste que falha**

`packages/cache/src/infra/__tests__/namespace-version.resolver.unit.ts`:

```ts
import { type Either, failure, success } from '@ruguin/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CacheConnectionError, CacheConsistency } from '../../domain'
import { type NamespaceVersionSource, NamespaceVersionResolver } from '../namespace-version.resolver'

const sourceReturning = (versions: number[]): { source: NamespaceVersionSource; calls: () => number } => {
  let index = 0

  return {
    source: {
      fetchVersion: async (): Promise<Either<CacheConnectionError, { version: number }>> => {
        const version = versions[Math.min(index, versions.length - 1)] ?? 1
        index += 1
        return success({ version })
      }
    },
    calls: () => index
  }
}

const failingSource: NamespaceVersionSource = {
  fetchVersion: async () => failure(new CacheConnectionError({ operation: 'resolveNamespaceVersion' }))
}

describe('NamespaceVersionResolver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('serves the memoised version while it is fresh, without touching the source again', async () => {
    const { source, calls } = sourceReturning([7, 8])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })

    const first = await resolver.resolveNamespaceVersion({ namespace: 'user' })
    const second = await resolver.resolveNamespaceVersion({ namespace: 'user' })

    if (first.isFailure() || second.isFailure()) throw new Error('expected success')
    expect(first.value.version).toBe(7)
    expect(second.value.version).toBe(7)
    expect(calls()).toBe(1)
  })

  it('refetches once the memo expires', async () => {
    const { source, calls } = sourceReturning([7, 8])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })

    await resolver.resolveNamespaceVersion({ namespace: 'user' })
    vi.advanceTimersByTime(5001)
    const second = await resolver.resolveNamespaceVersion({ namespace: 'user' })

    if (second.isFailure()) throw new Error('expected success')
    expect(second.value.version).toBe(8)
    expect(calls()).toBe(2)
  })

  it('never consults the memo in strong mode', async () => {
    const { source, calls } = sourceReturning([7, 8])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })

    await resolver.resolveNamespaceVersion({ namespace: 'user' })
    const second = await resolver.resolveNamespaceVersion({
      namespace: 'user',
      consistency: CacheConsistency.STRONG
    })

    if (second.isFailure()) throw new Error('expected success')
    expect(second.value.version).toBe(8)
    expect(calls()).toBe(2)
  })

  it('takes the strong mode from the namespace config without a per-call flag', async () => {
    const { source, calls } = sourceReturning([7, 8])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: { 'api-key': { consistency: CacheConsistency.STRONG } }
    })

    await resolver.resolveNamespaceVersion({ namespace: 'api-key' })
    await resolver.resolveNamespaceVersion({ namespace: 'api-key' })

    expect(calls()).toBe(2)
  })

  it('lets a per-call value override the namespace config', async () => {
    const { source, calls } = sourceReturning([7, 7])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: { 'api-key': { consistency: CacheConsistency.STRONG } }
    })

    await resolver.resolveNamespaceVersion({ namespace: 'api-key' })
    await resolver.resolveNamespaceVersion({ namespace: 'api-key', consistency: CacheConsistency.EVENTUAL })

    expect(calls()).toBe(1)
  })

  it('bypasses the memo entirely when the local ttl is zero', async () => {
    const { source, calls } = sourceReturning([7, 8])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 0,
      namespaces: {}
    })

    await resolver.resolveNamespaceVersion({ namespace: 'user' })
    await resolver.resolveNamespaceVersion({ namespace: 'user' })

    expect(calls()).toBe(2)
  })

  it('falls back to the last known version when the source fails in eventual mode', async () => {
    const { source } = sourceReturning([7])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })

    await resolver.resolveNamespaceVersion({ namespace: 'user' })
    vi.advanceTimersByTime(5001)

    const degraded = new NamespaceVersionResolver({
      source: failingSource,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })
    degraded.applyBroadcast({ namespace: 'user', version: 7 })
    vi.advanceTimersByTime(5001)

    const result = await degraded.resolveNamespaceVersion({ namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.version).toBe(7)
  })

  it('falls back to version 1 when the source fails and nothing was ever known', async () => {
    const resolver = new NamespaceVersionResolver({
      source: failingSource,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })

    const result = await resolver.resolveNamespaceVersion({ namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.version).toBe(1)
  })

  it('propagates the failure in strong mode rather than serving a guess', async () => {
    const resolver = new NamespaceVersionResolver({
      source: failingSource,
      defaultConsistency: CacheConsistency.STRONG,
      localTtlInMs: 5000,
      namespaces: {}
    })

    const result = await resolver.resolveNamespaceVersion({ namespace: 'user' })

    expect(result.isFailure()).toBe(true)
  })

  it('applies a broadcast that moves the version forward', async () => {
    const { source, calls } = sourceReturning([7])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })

    await resolver.resolveNamespaceVersion({ namespace: 'user' })
    resolver.applyBroadcast({ namespace: 'user', version: 9 })
    const result = await resolver.resolveNamespaceVersion({ namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.version).toBe(9)
    expect(calls()).toBe(1)
  })

  it('ignores a broadcast that would move the version backwards', async () => {
    const { source } = sourceReturning([7])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })

    await resolver.resolveNamespaceVersion({ namespace: 'user' })
    resolver.applyBroadcast({ namespace: 'user', version: 3 })
    const result = await resolver.resolveNamespaceVersion({ namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.version).toBe(7)
  })

  it('drops the whole memo on clearMemo, not just one namespace', async () => {
    const { source, calls } = sourceReturning([7, 7, 8, 8])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })

    await resolver.resolveNamespaceVersion({ namespace: 'user' })
    await resolver.resolveNamespaceVersion({ namespace: 'order' })
    resolver.clearMemo()
    await resolver.resolveNamespaceVersion({ namespace: 'user' })
    await resolver.resolveNamespaceVersion({ namespace: 'order' })

    expect(calls()).toBe(4)
  })
})
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../namespace-version.resolver'`.

- [ ] **Step 3: Implementar**

```ts
// packages/cache/src/infra/namespace-version.resolver.ts
import { type Either, failure, success } from '@ruguin/utils'

import {
  type CacheConnectionError,
  CacheConsistency,
  type IResolveNamespaceVersionProvider,
  type ResolveNamespaceVersionProviderDTO
} from '../domain'

export type NamespaceVersionSource = Readonly<{
  fetchVersion: (input: {
    namespace: string
    consistency: CacheConsistency
  }) => Promise<Either<CacheConnectionError, Readonly<{ version: number }>>>
}>

export type NamespaceConfig = Readonly<Record<string, Readonly<{ consistency?: CacheConsistency }>>>

type MemoEntry = Readonly<{ version: number; expiresAt: number }>

const INITIAL_VERSION: number = 1

export class NamespaceVersionResolver implements IResolveNamespaceVersionProvider {
  private readonly memo: Map<string, MemoEntry> = new Map<string, MemoEntry>()
  private readonly source: NamespaceVersionSource
  private readonly defaultConsistency: CacheConsistency
  private readonly localTtlInMs: number
  private readonly namespaces: NamespaceConfig

  constructor(input: {
    source: NamespaceVersionSource
    defaultConsistency: CacheConsistency
    localTtlInMs: number
    namespaces: NamespaceConfig
  }) {
    this.source = input.source
    this.defaultConsistency = input.defaultConsistency
    this.localTtlInMs = input.localTtlInMs
    this.namespaces = input.namespaces
  }

  public async resolveNamespaceVersion(
    input: ResolveNamespaceVersionProviderDTO.Input
  ): ResolveNamespaceVersionProviderDTO.Output {
    const consistency: CacheConsistency = this.resolveConsistency(input)

    if (consistency === CacheConsistency.EVENTUAL) {
      const memoised: number | null = this.readMemo({ namespace: input.namespace })
      if (memoised !== null) return success({ version: memoised })
    }

    const fetched = await this.source.fetchVersion({ namespace: input.namespace, consistency })

    if (fetched.isFailure()) {
      /*
       * Strong mode asked for a guarantee, so a guess would be a lie: propagate and let
       * getOrSet fall through to the loader. Eventual mode degrades instead, per spec §4.4.
       */
      if (consistency === CacheConsistency.STRONG) return failure(fetched.value)

      return success({ version: this.memo.get(input.namespace)?.version ?? INITIAL_VERSION })
    }

    this.writeMemo({ namespace: input.namespace, version: fetched.value.version })

    return success({ version: fetched.value.version })
  }

  public applyBroadcast(input: { namespace: string; version: number }): void {
    const current: MemoEntry | undefined = this.memo.get(input.namespace)

    // Out-of-order or redelivered messages must never walk the version backwards.
    if (current !== undefined && current.version >= input.version) return

    this.writeMemo({ namespace: input.namespace, version: input.version })
  }

  public clearMemo(): void {
    this.memo.clear()
  }

  private resolveConsistency(input: ResolveNamespaceVersionProviderDTO.Input): CacheConsistency {
    return input.consistency ?? this.namespaces[input.namespace]?.consistency ?? this.defaultConsistency
  }

  private readMemo(input: { namespace: string }): number | null {
    if (this.localTtlInMs === 0) return null

    const entry: MemoEntry | undefined = this.memo.get(input.namespace)
    if (entry === undefined) return null
    if (Date.now() >= entry.expiresAt) return null

    return entry.version
  }

  private writeMemo(input: { namespace: string; version: number }): void {
    this.memo.set(input.namespace, {
      version: input.version,
      expiresAt: Date.now() + this.localTtlInMs
    })
  }
}
```

Repare que `writeMemo` grava mesmo com `localTtlInMs === 0`: a entrada nunca é lida como memo válido, mas continua sendo o "última versão conhecida" que o fallback de falha usa.

Atualize `packages/cache/src/infra/index.ts`:

```ts
export * from './key-builder'
export * from './namespace-version.resolver'
export * from './serializers'
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos três, com 13 casos verdes no resolver.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src/infra
git commit -m "feat(cache): add namespace version resolver with consistency cascade"
```

---

### Task 10: Driver `noop` (Null Object)

**Files:**

- Create: `packages/cache/src/infra/drivers/noop/noop-cache.driver.ts`, `index.ts`
- Create: `packages/cache/src/infra/drivers/index.ts`
- Modify: `packages/cache/src/infra/index.ts`
- Test: `packages/cache/src/infra/drivers/noop/__tests__/noop-cache.driver.unit.ts`

**Interfaces:**

- Consumes: `ICacheDriver` e os DTOs folha.
- Produces: `class NoopCacheDriver implements ICacheDriver` — construtor sem argumentos.

Este driver existe para desligar o cache por configuração (`CACHE_DRIVER=noop`) sem espalhar `if (cacheEnabled)` pelo código. Implementá-lo agora também é o primeiro teste real de que `ICacheDriver` é implementável. Ele **não** implementa `getOrSet` nem `executeWithLock` — essas vêm dos orquestradores das Tasks 13 e 14.

- [ ] **Step 1: Escrever o teste que falha**

`packages/cache/src/infra/drivers/noop/__tests__/noop-cache.driver.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { CacheDriver, CacheHealthStatus } from '../../../../domain'
import { NoopCacheDriver } from '../noop-cache.driver'

describe('NoopCacheDriver', () => {
  const provider = new NoopCacheDriver()

  it('always misses on read', async () => {
    const result = await provider.get<string>({ key: 'a', namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toBeNull()
  })

  it('accepts a write and discards it', async () => {
    const written = await provider.set({ key: 'a', namespace: 'user', value: 'v', ttlInMs: 1000 })
    const read = await provider.get<string>({ key: 'a', namespace: 'user' })

    expect(written.isSuccess()).toBe(true)
    if (read.isFailure()) throw new Error('expected success')
    expect(read.value.value).toBeNull()
  })

  it('grants every lock, since there is nothing to coordinate', async () => {
    const first = await provider.acquire({ key: 'a', namespace: 'user', ttlInMs: 1000 })
    const second = await provider.acquire({ key: 'a', namespace: 'user', ttlInMs: 1000 })

    expect(first.isSuccess()).toBe(true)
    expect(second.isSuccess()).toBe(true)
  })

  it('reports itself as healthy', async () => {
    const result = await provider.healthCheck()

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.status).toBe(CacheHealthStatus.HEALTHY)
    expect(result.value.driver).toBe(CacheDriver.NOOP)
    expect(result.value.replicas).toEqual([])
  })

  it('counts from zero on every increment because nothing persists', async () => {
    await provider.increment({ key: 'hits', namespace: 'rate' })
    const second = await provider.increment({ key: 'hits', namespace: 'rate' })

    if (second.isFailure()) throw new Error('expected success')
    expect(second.value.value).toBe(0)
  })
})
```

`increment` devolver `0` é deliberado: qualquer outro valor sugeriria que a contagem está sendo mantida. Com `noop`, quem usa rate limiting precisa ver que o limite não está sendo aplicado.

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../noop-cache.driver'`.

- [ ] **Step 3: Implementar**

```ts
// packages/cache/src/infra/drivers/noop/noop-cache.driver.ts
import { success } from '@ruguin/utils'

import {
  type AcquireLockProviderDTO,
  CacheDriver,
  CacheHealthStatus,
  type ConnectProviderDTO,
  type CountScoresProviderDTO,
  type DecrementCounterProviderDTO,
  type DeleteCacheProviderDTO,
  type DisconnectProviderDTO,
  type ExtendLockProviderDTO,
  type GetCacheProviderDTO,
  type GetCounterProviderDTO,
  type GetRankProviderDTO,
  type GetScoreProviderDTO,
  type GetTopScoresProviderDTO,
  type HealthCheckProviderDTO,
  type ICacheDriver,
  type IncrementCounterProviderDTO,
  type IncrementScoreProviderDTO,
  type InvalidateNamespaceProviderDTO,
  type ReleaseLockProviderDTO,
  type RemoveScoreProviderDTO,
  type ResolveNamespaceVersionProviderDTO,
  type SetCacheProviderDTO,
  type SetIfNotExistsCacheProviderDTO,
  type SetScoreProviderDTO
} from '../../../domain'

const NOOP_TOKEN: string = 'noop'

export class NoopCacheDriver implements ICacheDriver {
  public async get<T>(_input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    return success({ found: false, value: null })
  }

  public async set<T>(_input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output {
    return success({ expiresAt: new Date() })
  }

  public async delete(_input: DeleteCacheProviderDTO.Input): DeleteCacheProviderDTO.Output {
    return success({ existed: false })
  }

  public async setIfNotExists<T>(
    _input: SetIfNotExistsCacheProviderDTO.Input<T>
  ): SetIfNotExistsCacheProviderDTO.Output {
    return success({ stored: true })
  }

  public async increment(_input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output {
    return success({ value: 0 })
  }

  public async decrement(_input: DecrementCounterProviderDTO.Input): DecrementCounterProviderDTO.Output {
    return success({ value: 0 })
  }

  public async getCounter(_input: GetCounterProviderDTO.Input): GetCounterProviderDTO.Output {
    return success({ value: 0 })
  }

  public async acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    return success({ token: NOOP_TOKEN, expiresAt: new Date(Date.now() + input.ttlInMs) })
  }

  public async release(_input: ReleaseLockProviderDTO.Input): ReleaseLockProviderDTO.Output {
    return success({ released: true })
  }

  public async extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output {
    return success({ expiresAt: new Date(Date.now() + input.ttlInMs) })
  }

  public async setScore(_input: SetScoreProviderDTO.Input): SetScoreProviderDTO.Output {
    return success({ created: true })
  }

  public async incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output {
    return success({ score: input.by })
  }

  public async getScore(_input: GetScoreProviderDTO.Input): GetScoreProviderDTO.Output {
    return success({ score: null })
  }

  public async getRank(_input: GetRankProviderDTO.Input): GetRankProviderDTO.Output {
    return success({ rank: null, total: 0 })
  }

  public async getTopScores(_input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output {
    return success({ entries: [] })
  }

  public async removeScore(_input: RemoveScoreProviderDTO.Input): RemoveScoreProviderDTO.Output {
    return success({ removed: false })
  }

  public async countScores(_input: CountScoresProviderDTO.Input): CountScoresProviderDTO.Output {
    return success({ total: 0 })
  }

  public async invalidateNamespace(
    _input: InvalidateNamespaceProviderDTO.Input
  ): InvalidateNamespaceProviderDTO.Output {
    return success({ version: 1 })
  }

  public async resolveNamespaceVersion(
    _input: ResolveNamespaceVersionProviderDTO.Input
  ): ResolveNamespaceVersionProviderDTO.Output {
    return success({ version: 1 })
  }

  public async connect(): ConnectProviderDTO.Output {
    return success({ connected: true })
  }

  public async disconnect(): DisconnectProviderDTO.Output {
    return success({ disconnected: true })
  }

  public async healthCheck(_input?: HealthCheckProviderDTO.Input): HealthCheckProviderDTO.Output {
    return success({
      status: CacheHealthStatus.HEALTHY,
      driver: CacheDriver.NOOP,
      checkedAt: new Date(),
      master: { reachable: true, latencyInMs: 0, role: 'noop' },
      replicas: [],
      memory: { usedBytes: 0, maxBytes: null, usedPercentage: null, evictedKeys: 0 },
      clients: { connected: 0, blocked: 0, rejectedTotal: 0 },
      server: { version: 'noop', uptimeInSeconds: 0 }
    })
  }
}
```

`packages/cache/src/infra/drivers/noop/index.ts`:

```ts
export * from './noop-cache.driver'
```

`packages/cache/src/infra/drivers/index.ts`:

```ts
export * from './noop'
```

Atualize `packages/cache/src/infra/index.ts`:

```ts
export * from './drivers'
export * from './key-builder'
export * from './namespace-version.resolver'
export * from './serializers'
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos três. Se o `check:types` reclamar de método faltando, é `ICacheDriver` cobrando um contrato ainda não implementado — adicione-o.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src/infra
git commit -m "feat(cache): add noop driver"
```

---

### Task 11: `MemoryStore` — armazenamento em processo com TTL

**Files:**

- Create: `packages/cache/src/infra/drivers/memory/memory.store.ts`
- Test: `packages/cache/src/infra/drivers/memory/__tests__/memory.store.unit.ts`

**Interfaces:**

- Consumes: nada do domínio — é uma estrutura de dados pura.
- Produces: `class MemoryStore` com
  - `setValue({ key, serialized, ttlInMs })`, `getValue({ key }): string | null`, `deleteValue({ key }): boolean`, `setValueIfAbsent({ key, serialized, ttlInMs }): boolean`
  - `incrementCounter({ key, by, ttlInMs }): number`, `getCounter({ key }): number`
  - `acquireLock({ key, token, ttlInMs }): boolean`, `releaseLock({ key, token }): 'released' | 'not-owned'`, `extendLock({ key, token, ttlInMs }): boolean`
  - `setScore({ key, member, score, ttlInMs }): boolean`, `incrementScore({ key, member, by, ttlInMs }): number`, `getScore({ key, member }): number | null`, `getRankAndTotal({ key, member }): { rank: number | null; total: number }`, `getTopScores({ key, limit, offset }): Array<{ member: string; score: number }>`, `removeScore({ key, member }): boolean`, `countScores({ key }): number`
  - `bumpVersion({ namespace }): number`, `getVersion({ namespace }): number`
  - `clear(): void`

A expiração é **preguiçosa**: nada é varrido em background, cada leitura descarta a entrada vencida. É o comportamento do Valkey e evita um timer por processo.

- [ ] **Step 1: Escrever o teste que falha**

`packages/cache/src/infra/drivers/memory/__tests__/memory.store.unit.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MemoryStore } from '../memory.store'

describe('MemoryStore', () => {
  let store: MemoryStore

  beforeEach(() => {
    vi.useFakeTimers()
    store = new MemoryStore()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a stored value before it expires', () => {
    store.setValue({ key: 'a', serialized: '"v"', ttlInMs: 1000 })

    expect(store.getValue({ key: 'a' })).toBe('"v"')
  })

  it('drops the value once the ttl has passed', () => {
    store.setValue({ key: 'a', serialized: '"v"', ttlInMs: 1000 })
    vi.advanceTimersByTime(1001)

    expect(store.getValue({ key: 'a' })).toBeNull()
  })

  it('reports whether a delete removed anything', () => {
    store.setValue({ key: 'a', serialized: '"v"', ttlInMs: 1000 })

    expect(store.deleteValue({ key: 'a' })).toBe(true)
    expect(store.deleteValue({ key: 'a' })).toBe(false)
  })

  it('stores only when absent, and treats an expired key as absent', () => {
    expect(store.setValueIfAbsent({ key: 'a', serialized: '"1"', ttlInMs: 1000 })).toBe(true)
    expect(store.setValueIfAbsent({ key: 'a', serialized: '"2"', ttlInMs: 1000 })).toBe(false)

    vi.advanceTimersByTime(1001)

    expect(store.setValueIfAbsent({ key: 'a', serialized: '"3"', ttlInMs: 1000 })).toBe(true)
    expect(store.getValue({ key: 'a' })).toBe('"3"')
  })

  it('accumulates counters and reads zero for an unknown key', () => {
    expect(store.getCounter({ key: 'hits' })).toBe(0)
    expect(store.incrementCounter({ key: 'hits', by: 1 })).toBe(1)
    expect(store.incrementCounter({ key: 'hits', by: 4 })).toBe(5)
    expect(store.incrementCounter({ key: 'hits', by: -2 })).toBe(3)
  })

  it('keeps the ttl set on the first increment and does not extend it later', () => {
    store.incrementCounter({ key: 'hits', by: 1, ttlInMs: 1000 })
    vi.advanceTimersByTime(600)
    store.incrementCounter({ key: 'hits', by: 1, ttlInMs: 1000 })
    vi.advanceTimersByTime(500)

    expect(store.getCounter({ key: 'hits' })).toBe(0)
  })

  it('grants a lock once and refuses it while held', () => {
    expect(store.acquireLock({ key: 'l', token: 't1', ttlInMs: 1000 })).toBe(true)
    expect(store.acquireLock({ key: 'l', token: 't2', ttlInMs: 1000 })).toBe(false)
  })

  it('grants the lock again after it expires', () => {
    store.acquireLock({ key: 'l', token: 't1', ttlInMs: 1000 })
    vi.advanceTimersByTime(1001)

    expect(store.acquireLock({ key: 'l', token: 't2', ttlInMs: 1000 })).toBe(true)
  })

  it('refuses to release a lock held by someone else', () => {
    store.acquireLock({ key: 'l', token: 't1', ttlInMs: 1000 })

    expect(store.releaseLock({ key: 'l', token: 't2' })).toBe('not-owned')
    expect(store.releaseLock({ key: 'l', token: 't1' })).toBe('released')
  })

  it('extends only for the current owner', () => {
    store.acquireLock({ key: 'l', token: 't1', ttlInMs: 1000 })

    expect(store.extendLock({ key: 'l', token: 't2', ttlInMs: 5000 })).toBe(false)
    expect(store.extendLock({ key: 'l', token: 't1', ttlInMs: 5000 })).toBe(true)

    vi.advanceTimersByTime(4000)

    expect(store.acquireLock({ key: 'l', token: 't3', ttlInMs: 1000 })).toBe(false)
  })

  it('ranks members by score descending, one-based', () => {
    store.setScore({ key: 'board', member: 'a', score: 10 })
    store.setScore({ key: 'board', member: 'b', score: 30 })
    store.setScore({ key: 'board', member: 'c', score: 20 })

    expect(store.getRankAndTotal({ key: 'board', member: 'b' })).toEqual({ rank: 1, total: 3 })
    expect(store.getRankAndTotal({ key: 'board', member: 'a' })).toEqual({ rank: 3, total: 3 })
    expect(store.getRankAndTotal({ key: 'board', member: 'zz' })).toEqual({ rank: null, total: 3 })
  })

  it('returns the top scores honouring limit and offset', () => {
    store.setScore({ key: 'board', member: 'a', score: 10 })
    store.setScore({ key: 'board', member: 'b', score: 30 })
    store.setScore({ key: 'board', member: 'c', score: 20 })

    expect(store.getTopScores({ key: 'board', limit: 2 })).toEqual([
      { member: 'b', score: 30 },
      { member: 'c', score: 20 }
    ])
    expect(store.getTopScores({ key: 'board', limit: 2, offset: 1 })).toEqual([
      { member: 'c', score: 20 },
      { member: 'a', score: 10 }
    ])
  })

  it('breaks score ties by member ascending', () => {
    store.setScore({ key: 'board', member: 'b', score: 10 })
    store.setScore({ key: 'board', member: 'a', score: 10 })

    expect(store.getTopScores({ key: 'board', limit: 2 })).toEqual([
      { member: 'a', score: 10 },
      { member: 'b', score: 10 }
    ])
  })

  it('reports whether setScore created or updated the member', () => {
    expect(store.setScore({ key: 'board', member: 'a', score: 1 })).toBe(true)
    expect(store.setScore({ key: 'board', member: 'a', score: 2 })).toBe(false)
    expect(store.getScore({ key: 'board', member: 'a' })).toBe(2)
  })

  it('accumulates and removes members', () => {
    store.incrementScore({ key: 'board', member: 'a', by: 5 })
    store.incrementScore({ key: 'board', member: 'a', by: 3 })

    expect(store.getScore({ key: 'board', member: 'a' })).toBe(8)
    expect(store.countScores({ key: 'board' })).toBe(1)
    expect(store.removeScore({ key: 'board', member: 'a' })).toBe(true)
    expect(store.removeScore({ key: 'board', member: 'a' })).toBe(false)
    expect(store.countScores({ key: 'board' })).toBe(0)
  })

  it('expires a whole sorted set by its key ttl', () => {
    store.setScore({ key: 'board', member: 'a', score: 1, ttlInMs: 1000 })
    vi.advanceTimersByTime(1001)

    expect(store.countScores({ key: 'board' })).toBe(0)
    expect(store.getScore({ key: 'board', member: 'a' })).toBeNull()
  })

  it('starts namespace versions at one and bumps them monotonically', () => {
    expect(store.getVersion({ namespace: 'user' })).toBe(1)
    expect(store.bumpVersion({ namespace: 'user' })).toBe(2)
    expect(store.bumpVersion({ namespace: 'user' })).toBe(3)
    expect(store.getVersion({ namespace: 'order' })).toBe(1)
  })

  it('wipes everything on clear', () => {
    store.setValue({ key: 'a', serialized: '"v"', ttlInMs: 1000 })
    store.bumpVersion({ namespace: 'user' })
    store.clear()

    expect(store.getValue({ key: 'a' })).toBeNull()
    expect(store.getVersion({ namespace: 'user' })).toBe(1)
  })
})
```

O teste de TTL do contador fixa uma decisão real: o TTL é definido na criação e **não** é renovado a cada incremento. Renovar transformaria um contador de janela fixa (que é o que rate limiting precisa) em um contador que nunca expira sob tráfego contínuo.

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../memory.store'`.

- [ ] **Step 3: Implementar**

```ts
// packages/cache/src/infra/drivers/memory/memory.store.ts
type Expirable = Readonly<{ expiresAt: number | null }>

type StoredValue = Expirable & Readonly<{ serialized: string }>
type StoredCounter = Expirable & { value: number }
type StoredLock = Readonly<{ token: string; expiresAt: number }>
type StoredScores = Expirable & Readonly<{ members: Map<string, number> }>

const INITIAL_VERSION: number = 1

const isExpired = (entry: Expirable): boolean => entry.expiresAt !== null && Date.now() >= entry.expiresAt

const expiryFrom = (ttlInMs: number | undefined): number | null => (ttlInMs === undefined ? null : Date.now() + ttlInMs)

export class MemoryStore {
  private readonly values: Map<string, StoredValue> = new Map<string, StoredValue>()
  private readonly counters: Map<string, StoredCounter> = new Map<string, StoredCounter>()
  private readonly locks: Map<string, StoredLock> = new Map<string, StoredLock>()
  private readonly scores: Map<string, StoredScores> = new Map<string, StoredScores>()
  private readonly versions: Map<string, number> = new Map<string, number>()

  public setValue(input: { key: string; serialized: string; ttlInMs?: number }): void {
    this.values.set(input.key, { serialized: input.serialized, expiresAt: expiryFrom(input.ttlInMs) })
  }

  public getValue(input: { key: string }): string | null {
    const entry: StoredValue | undefined = this.values.get(input.key)
    if (entry === undefined) return null

    if (isExpired(entry)) {
      this.values.delete(input.key)
      return null
    }

    return entry.serialized
  }

  public deleteValue(input: { key: string }): boolean {
    const existed: boolean = this.getValue({ key: input.key }) !== null
    this.values.delete(input.key)

    return existed
  }

  public setValueIfAbsent(input: { key: string; serialized: string; ttlInMs?: number }): boolean {
    if (this.getValue({ key: input.key }) !== null) return false

    this.setValue(input)

    return true
  }

  public incrementCounter(input: { key: string; by: number; ttlInMs?: number }): number {
    const entry: StoredCounter | undefined = this.counters.get(input.key)

    if (entry === undefined || isExpired(entry)) {
      const created: StoredCounter = { value: input.by, expiresAt: expiryFrom(input.ttlInMs) }
      this.counters.set(input.key, created)

      return created.value
    }

    // The window is anchored to the first increment; renewing it here would make a
    // fixed-window rate limiter never reset under sustained traffic.
    entry.value += input.by

    return entry.value
  }

  public getCounter(input: { key: string }): number {
    const entry: StoredCounter | undefined = this.counters.get(input.key)
    if (entry === undefined) return 0

    if (isExpired(entry)) {
      this.counters.delete(input.key)
      return 0
    }

    return entry.value
  }

  public acquireLock(input: { key: string; token: string; ttlInMs: number }): boolean {
    const held: StoredLock | undefined = this.locks.get(input.key)

    if (held !== undefined && Date.now() < held.expiresAt) return false

    this.locks.set(input.key, { token: input.token, expiresAt: Date.now() + input.ttlInMs })

    return true
  }

  public releaseLock(input: { key: string; token: string }): 'released' | 'not-owned' {
    const held: StoredLock | undefined = this.locks.get(input.key)

    if (held === undefined || Date.now() >= held.expiresAt) return 'not-owned'
    if (held.token !== input.token) return 'not-owned'

    this.locks.delete(input.key)

    return 'released'
  }

  public extendLock(input: { key: string; token: string; ttlInMs: number }): boolean {
    const held: StoredLock | undefined = this.locks.get(input.key)

    if (held === undefined || Date.now() >= held.expiresAt) return false
    if (held.token !== input.token) return false

    this.locks.set(input.key, { token: held.token, expiresAt: Date.now() + input.ttlInMs })

    return true
  }

  public setScore(input: { key: string; member: string; score: number; ttlInMs?: number }): boolean {
    const members: Map<string, number> = this.membersOf({ key: input.key, ttlInMs: input.ttlInMs })
    const created: boolean = !members.has(input.member)

    members.set(input.member, input.score)

    return created
  }

  public incrementScore(input: { key: string; member: string; by: number; ttlInMs?: number }): number {
    const members: Map<string, number> = this.membersOf({ key: input.key, ttlInMs: input.ttlInMs })
    const next: number = (members.get(input.member) ?? 0) + input.by

    members.set(input.member, next)

    return next
  }

  public getScore(input: { key: string; member: string }): number | null {
    return this.liveMembers({ key: input.key })?.get(input.member) ?? null
  }

  public getRankAndTotal(input: { key: string; member: string }): { rank: number | null; total: number } {
    const ordered: Array<{ member: string; score: number }> = this.ordered({ key: input.key })
    const index: number = ordered.findIndex((entry) => entry.member === input.member)

    return { rank: index === -1 ? null : index + 1, total: ordered.length }
  }

  public getTopScores(input: {
    key: string
    limit: number
    offset?: number
  }): Array<{ member: string; score: number }> {
    const offset: number = input.offset ?? 0

    return this.ordered({ key: input.key }).slice(offset, offset + input.limit)
  }

  public removeScore(input: { key: string; member: string }): boolean {
    return this.liveMembers({ key: input.key })?.delete(input.member) ?? false
  }

  public countScores(input: { key: string }): number {
    return this.liveMembers({ key: input.key })?.size ?? 0
  }

  public bumpVersion(input: { namespace: string }): number {
    const next: number = this.getVersion({ namespace: input.namespace }) + 1
    this.versions.set(input.namespace, next)

    return next
  }

  public getVersion(input: { namespace: string }): number {
    return this.versions.get(input.namespace) ?? INITIAL_VERSION
  }

  public clear(): void {
    this.values.clear()
    this.counters.clear()
    this.locks.clear()
    this.scores.clear()
    this.versions.clear()
  }

  private membersOf(input: { key: string; ttlInMs?: number }): Map<string, number> {
    const live: Map<string, number> | null = this.liveMembers({ key: input.key })
    if (live !== null) return live

    const created: StoredScores = { members: new Map<string, number>(), expiresAt: expiryFrom(input.ttlInMs) }
    this.scores.set(input.key, created)

    return created.members
  }

  private liveMembers(input: { key: string }): Map<string, number> | null {
    const entry: StoredScores | undefined = this.scores.get(input.key)
    if (entry === undefined) return null

    if (isExpired(entry)) {
      this.scores.delete(input.key)
      return null
    }

    return entry.members
  }

  private ordered(input: { key: string }): Array<{ member: string; score: number }> {
    const members: Map<string, number> | null = this.liveMembers({ key: input.key })
    if (members === null) return []

    return [...members.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((left, right) => right.score - left.score || left.member.localeCompare(right.member))
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos três.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src/infra/drivers/memory
git commit -m "feat(cache): add in-memory store with lazy ttl expiry"
```

---

### Task 12: Driver `memory`

**Files:**

- Create: `packages/cache/src/infra/drivers/memory/memory-cache.driver.ts`, `index.ts`
- Modify: `packages/cache/src/infra/drivers/index.ts`
- Test: `packages/cache/src/infra/drivers/memory/__tests__/memory-cache.driver.unit.ts`

**Interfaces:**

- Consumes: `MemoryStore` (Task 11), `KeyBuilder` (Task 8), `JsonSerializerStrategy` (Task 7), `ICacheDriver`.
- Produces: `class MemoryCacheDriver implements ICacheDriver` — `new MemoryCacheDriver({ keyBuilder, serializer, store?, defaultTtlInMs, jitterRatio })`. Expõe `.store` como `readonly` para os testes inspecionarem, e `.isConnected` interno.

Todas as chaves passam pelo mesmo `KeyBuilder` do driver Valkey, então o versionamento de namespace e a validação de chave se comportam igual nos dois — que é o ponto de ter este driver.

- [ ] **Step 1: Escrever o teste que falha**

`packages/cache/src/infra/drivers/memory/__tests__/memory-cache.driver.unit.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CacheDriver, CacheHealthStatus, InvalidCacheKeyError } from '../../../../domain'
import { KeyBuilder } from '../../../key-builder'
import { JsonSerializerStrategy } from '../../../serializers'
import { MemoryCacheDriver } from '../memory-cache.driver'

const buildDriver = (): MemoryCacheDriver =>
  new MemoryCacheDriver({
    keyBuilder: new KeyBuilder({ prefix: 'ruguin:test' }),
    serializer: new JsonSerializerStrategy(),
    defaultTtlInMs: 300_000,
    jitterRatio: 0
  })

describe('MemoryCacheDriver', () => {
  let driver: MemoryCacheDriver

  beforeEach(async () => {
    vi.useFakeTimers()
    driver = buildDriver()
    await driver.connect()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('round-trips a value through set and get', async () => {
    await driver.set({ key: '1', namespace: 'user', value: { id: '1' }, ttlInMs: 1000 })
    const result = await driver.get<{ id: string }>({ key: '1', namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toEqual({ id: '1' })
  })

  it('misses once the ttl elapses', async () => {
    await driver.set({ key: '1', namespace: 'user', value: 'v', ttlInMs: 1000 })
    vi.advanceTimersByTime(1001)
    const result = await driver.get<string>({ key: '1', namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toBeNull()
  })

  it('distinguishes a miss from a deliberately cached null', async () => {
    const miss = await driver.get<string>({ key: 'absent', namespace: 'user' })

    if (miss.isFailure()) throw new Error('expected success')
    expect(miss.value).toEqual({ found: false, value: null })

    await driver.set({ key: 'known-absent', namespace: 'user', value: null, ttlInMs: 1000 })
    const negative = await driver.get<string>({ key: 'known-absent', namespace: 'user' })

    if (negative.isFailure()) throw new Error('expected success')
    expect(negative.value).toEqual({ found: true, value: null })
  })

  it('applies the default ttl when the caller omits one', async () => {
    await driver.set({ key: '1', namespace: 'user', value: 'v' })
    vi.advanceTimersByTime(299_999)
    const before = await driver.get<string>({ key: '1', namespace: 'user' })
    vi.advanceTimersByTime(2)
    const after = await driver.get<string>({ key: '1', namespace: 'user' })

    if (before.isFailure() || after.isFailure()) throw new Error('expected success')
    expect(before.value.value).toBe('v')
    expect(after.value.value).toBeNull()
  })

  it('treats a value rejected by validate as a miss', async () => {
    await driver.set({ key: '1', namespace: 'user', value: { legacy: true }, ttlInMs: 1000 })
    const result = await driver.get<{ id: string }>({
      key: '1',
      namespace: 'user',
      validate: (value) => typeof value === 'object' && value !== null && 'id' in value
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toBeNull()
  })

  it('rejects an invalid key before touching the store', async () => {
    const result = await driver.get({ key: 'bad key', namespace: 'user' })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBeInstanceOf(InvalidCacheKeyError)
  })

  it('makes every key under a namespace unreachable once it is invalidated', async () => {
    await driver.set({ key: '1', namespace: 'user', value: 'v', ttlInMs: 60_000 })
    await driver.set({ key: '2', namespace: 'user', value: 'w', ttlInMs: 60_000 })
    await driver.set({ key: '1', namespace: 'order', value: 'kept', ttlInMs: 60_000 })

    const bumped = await driver.invalidateNamespace({ namespace: 'user' })

    if (bumped.isFailure()) throw new Error('expected success')
    expect(bumped.value.version).toBe(2)

    const first = await driver.get<string>({ key: '1', namespace: 'user' })
    const second = await driver.get<string>({ key: '2', namespace: 'user' })
    const untouched = await driver.get<string>({ key: '1', namespace: 'order' })

    if (first.isFailure() || second.isFailure() || untouched.isFailure()) throw new Error('expected success')
    expect(first.value.value).toBeNull()
    expect(second.value.value).toBeNull()
    expect(untouched.value.value).toBe('kept')
  })

  it('stores only the first idempotency key', async () => {
    const first = await driver.setIfNotExists({ key: 'evt-1', namespace: 'webhook', value: 'a', ttlInMs: 1000 })
    const second = await driver.setIfNotExists({ key: 'evt-1', namespace: 'webhook', value: 'b', ttlInMs: 1000 })

    if (first.isFailure() || second.isFailure()) throw new Error('expected success')
    expect(first.value.stored).toBe(true)
    expect(second.value.stored).toBe(false)
  })

  it('counts within a namespace', async () => {
    await driver.increment({ key: 'ip-1', namespace: 'rate', ttlInMs: 60_000 })
    const second = await driver.increment({ key: 'ip-1', namespace: 'rate', by: 2 })
    const read = await driver.getCounter({ key: 'ip-1', namespace: 'rate' })

    if (second.isFailure() || read.isFailure()) throw new Error('expected success')
    expect(second.value.value).toBe(3)
    expect(read.value.value).toBe(3)
  })

  it('holds a lock against a second caller and releases it only for the owner', async () => {
    const first = await driver.acquire({ key: 'job', namespace: 'lock', ttlInMs: 5000 })
    const second = await driver.acquire({ key: 'job', namespace: 'lock', ttlInMs: 5000 })

    if (first.isFailure()) throw new Error('expected success')
    expect(second.isFailure()).toBe(true)

    const stolen = await driver.release({ key: 'job', namespace: 'lock', token: 'not-mine' })
    expect(stolen.isFailure()).toBe(true)

    const released = await driver.release({ key: 'job', namespace: 'lock', token: first.value.token })
    expect(released.isSuccess()).toBe(true)
  })

  it('retries a busy lock for the configured number of attempts', async () => {
    await driver.acquire({ key: 'job', namespace: 'lock', ttlInMs: 5000 })
    const contended = driver.acquire({
      key: 'job',
      namespace: 'lock',
      ttlInMs: 5000,
      retry: { attempts: 3, delayInMs: 10 }
    })

    await vi.advanceTimersByTimeAsync(50)
    const result = await contended

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value.message).toContain('3')
  })

  it('ranks a leaderboard', async () => {
    await driver.setScore({ key: 'weekly', namespace: 'board', member: 'a', score: 10 })
    await driver.incrementScore({ key: 'weekly', namespace: 'board', member: 'b', by: 30 })

    const rank = await driver.getRank({ key: 'weekly', namespace: 'board', member: 'b' })
    const top = await driver.getTopScores({ key: 'weekly', namespace: 'board', limit: 1 })

    if (rank.isFailure() || top.isFailure()) throw new Error('expected success')
    expect(rank.value).toEqual({ rank: 1, total: 2 })
    expect(top.value.entries).toEqual([{ member: 'b', score: 30 }])
  })

  it('refuses to serve reads before connect', async () => {
    const fresh = buildDriver()
    const result = await fresh.get({ key: '1', namespace: 'user' })

    expect(result.isFailure()).toBe(true)
  })

  it('reports itself healthy and names the memory driver', async () => {
    const result = await driver.healthCheck()

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.status).toBe(CacheHealthStatus.HEALTHY)
    expect(result.value.driver).toBe(CacheDriver.MEMORY)
  })
})
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../memory-cache.driver'`.

- [ ] **Step 3: Implementar**

```ts
// packages/cache/src/infra/drivers/memory/memory-cache.driver.ts
import { type Either, failure, success } from '@ruguin/utils'

import {
  type AcquireLockProviderDTO,
  CacheDriver,
  CacheHealthStatus,
  CacheNotInitializedError,
  type ConnectProviderDTO,
  type CountScoresProviderDTO,
  type DecrementCounterProviderDTO,
  type DeleteCacheProviderDTO,
  type DisconnectProviderDTO,
  type ExtendLockProviderDTO,
  type GetCacheProviderDTO,
  type GetCounterProviderDTO,
  type GetRankProviderDTO,
  type GetScoreProviderDTO,
  type GetTopScoresProviderDTO,
  type HealthCheckProviderDTO,
  type ICacheDriver,
  type ISerializerStrategy,
  type IncrementCounterProviderDTO,
  type IncrementScoreProviderDTO,
  type InvalidCacheKeyError,
  type InvalidateNamespaceProviderDTO,
  LockNotAcquiredError,
  LockNotOwnedError,
  type ReleaseLockProviderDTO,
  type RemoveScoreProviderDTO,
  type ResolveNamespaceVersionProviderDTO,
  type SetCacheProviderDTO,
  type SetIfNotExistsCacheProviderDTO,
  type SetScoreProviderDTO
} from '../../../domain'
import { type KeyBuilder } from '../../key-builder'
import { MemoryStore } from './memory.store'

const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

export class MemoryCacheDriver implements ICacheDriver {
  public readonly store: MemoryStore

  private readonly keyBuilder: KeyBuilder
  private readonly serializer: ISerializerStrategy
  private readonly defaultTtlInMs: number
  private readonly jitterRatio: number
  private connected: boolean = false

  constructor(input: {
    keyBuilder: KeyBuilder
    serializer: ISerializerStrategy
    defaultTtlInMs: number
    jitterRatio: number
    store?: MemoryStore
  }) {
    this.keyBuilder = input.keyBuilder
    this.serializer = input.serializer
    this.defaultTtlInMs = input.defaultTtlInMs
    this.jitterRatio = input.jitterRatio
    this.store = input.store ?? new MemoryStore()
  }

  public async connect(): ConnectProviderDTO.Output {
    this.connected = true
    return success({ connected: true })
  }

  public async disconnect(): DisconnectProviderDTO.Output {
    this.connected = false
    this.store.clear()
    return success({ disconnected: true })
  }

  public async get<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'get' })
    if (key.isFailure()) return failure(key.value)

    const raw: string | null = this.store.getValue({ key: key.value })
    if (raw === null) return success({ found: false, value: null })

    const deserialized = this.serializer.deserialize<T>({ raw })
    // A corrupt entry is a miss, not an outage: drop it and let the caller reload.
    if (deserialized.isFailure()) return success({ found: false, value: null })

    if (input.validate !== undefined && !input.validate(deserialized.value.value)) {
      return success({ found: false, value: null })
    }

    return success({ found: true, value: deserialized.value.value })
  }

  public async set<T>(input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'set' })
    if (key.isFailure()) return failure(key.value)

    const serialized = this.serializer.serialize({ value: input.value })
    if (serialized.isFailure()) return failure(serialized.value)

    const ttlInMs: number = this.effectiveTtl({ ttlInMs: input.ttlInMs, applyJitter: input.applyJitter })
    this.store.setValue({ key: key.value, serialized: serialized.value.serialized, ttlInMs })

    return success({ expiresAt: new Date(Date.now() + ttlInMs) })
  }

  public async delete(input: DeleteCacheProviderDTO.Input): DeleteCacheProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'delete' })
    if (key.isFailure()) return failure(key.value)

    return success({ existed: this.store.deleteValue({ key: key.value }) })
  }

  public async setIfNotExists<T>(
    input: SetIfNotExistsCacheProviderDTO.Input<T>
  ): SetIfNotExistsCacheProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'setIfNotExists' })
    if (key.isFailure()) return failure(key.value)

    const serialized = this.serializer.serialize({ value: input.value })
    if (serialized.isFailure()) return failure(serialized.value)

    const stored: boolean = this.store.setValueIfAbsent({
      key: key.value,
      serialized: serialized.value.serialized,
      ttlInMs: input.ttlInMs
    })

    return success({ stored })
  }

  public async increment(input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'increment' })
    if (key.isFailure()) return failure(key.value)

    return success({
      value: this.store.incrementCounter({ key: key.value, by: input.by ?? 1, ttlInMs: input.ttlInMs })
    })
  }

  public async decrement(input: DecrementCounterProviderDTO.Input): DecrementCounterProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'decrement' })
    if (key.isFailure()) return failure(key.value)

    return success({ value: this.store.incrementCounter({ key: key.value, by: -(input.by ?? 1) }) })
  }

  public async getCounter(input: GetCounterProviderDTO.Input): GetCounterProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'getCounter' })
    if (key.isFailure()) return failure(key.value)

    return success({ value: this.store.getCounter({ key: key.value }) })
  }

  public async acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    const guard = this.ensureConnected({ operation: 'acquire' })
    if (guard.isFailure()) return failure(guard.value)

    const key = this.keyBuilder.buildLockKey({ namespace: input.namespace, key: input.key })
    if (key.isFailure()) return failure(key.value)

    const attempts: number = input.retry?.attempts ?? 1
    const token: string = crypto.randomUUID()

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (this.store.acquireLock({ key: key.value.physicalKey, token, ttlInMs: input.ttlInMs })) {
        return success({ token, expiresAt: new Date(Date.now() + input.ttlInMs) })
      }

      if (attempt < attempts) await sleep(input.retry?.delayInMs ?? 0)
    }

    return failure(new LockNotAcquiredError({ lockKey: key.value.physicalKey, attempts }))
  }

  public async release(input: ReleaseLockProviderDTO.Input): ReleaseLockProviderDTO.Output {
    const key = this.keyBuilder.buildLockKey({ namespace: input.namespace, key: input.key })
    if (key.isFailure()) return failure(key.value)

    const outcome = this.store.releaseLock({ key: key.value.physicalKey, token: input.token })
    if (outcome === 'not-owned') return failure(new LockNotOwnedError({ lockKey: key.value.physicalKey }))

    return success({ released: true })
  }

  public async extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output {
    const key = this.keyBuilder.buildLockKey({ namespace: input.namespace, key: input.key })
    if (key.isFailure()) return failure(key.value)

    const extended: boolean = this.store.extendLock({
      key: key.value.physicalKey,
      token: input.token,
      ttlInMs: input.ttlInMs
    })
    if (!extended) return failure(new LockNotOwnedError({ lockKey: key.value.physicalKey }))

    return success({ expiresAt: new Date(Date.now() + input.ttlInMs) })
  }

  public async setScore(input: SetScoreProviderDTO.Input): SetScoreProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'setScore' })
    if (key.isFailure()) return failure(key.value)

    return success({
      created: this.store.setScore({
        key: key.value,
        member: input.member,
        score: input.score,
        ttlInMs: input.ttlInMs
      })
    })
  }

  public async incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'incrementScore' })
    if (key.isFailure()) return failure(key.value)

    return success({
      score: this.store.incrementScore({
        key: key.value,
        member: input.member,
        by: input.by,
        ttlInMs: input.ttlInMs
      })
    })
  }

  public async getScore(input: GetScoreProviderDTO.Input): GetScoreProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'getScore' })
    if (key.isFailure()) return failure(key.value)

    return success({ score: this.store.getScore({ key: key.value, member: input.member }) })
  }

  public async getRank(input: GetRankProviderDTO.Input): GetRankProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'getRank' })
    if (key.isFailure()) return failure(key.value)

    return success(this.store.getRankAndTotal({ key: key.value, member: input.member }))
  }

  public async getTopScores(input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'getTopScores' })
    if (key.isFailure()) return failure(key.value)

    return success({
      entries: this.store.getTopScores({ key: key.value, limit: input.limit, offset: input.offset })
    })
  }

  public async removeScore(input: RemoveScoreProviderDTO.Input): RemoveScoreProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'removeScore' })
    if (key.isFailure()) return failure(key.value)

    return success({ removed: this.store.removeScore({ key: key.value, member: input.member }) })
  }

  public async countScores(input: CountScoresProviderDTO.Input): CountScoresProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'countScores' })
    if (key.isFailure()) return failure(key.value)

    return success({ total: this.store.countScores({ key: key.value }) })
  }

  public async invalidateNamespace(input: InvalidateNamespaceProviderDTO.Input): InvalidateNamespaceProviderDTO.Output {
    const guard = this.ensureConnected({ operation: 'invalidateNamespace' })
    if (guard.isFailure()) return failure(guard.value)

    return success({ version: this.store.bumpVersion({ namespace: input.namespace }) })
  }

  public async resolveNamespaceVersion(
    input: ResolveNamespaceVersionProviderDTO.Input
  ): ResolveNamespaceVersionProviderDTO.Output {
    const guard = this.ensureConnected({ operation: 'resolveNamespaceVersion' })
    if (guard.isFailure()) return failure(guard.value)

    return success({ version: this.store.getVersion({ namespace: input.namespace }) })
  }

  public async healthCheck(_input?: HealthCheckProviderDTO.Input): HealthCheckProviderDTO.Output {
    const guard = this.ensureConnected({ operation: 'healthCheck' })
    if (guard.isFailure()) return failure(guard.value)

    return success({
      status: CacheHealthStatus.HEALTHY,
      driver: CacheDriver.MEMORY,
      checkedAt: new Date(),
      master: { reachable: true, latencyInMs: 0, role: 'memory' },
      replicas: [],
      memory: { usedBytes: 0, maxBytes: null, usedPercentage: null, evictedKeys: 0 },
      clients: { connected: 1, blocked: 0, rejectedTotal: 0 },
      server: { version: 'memory', uptimeInSeconds: 0 }
    })
  }

  private physicalKey(input: {
    namespace: string
    key: string
    operation: string
  }): Either<CacheNotInitializedError | InvalidCacheKeyError, string> {
    const guard = this.ensureConnected({ operation: input.operation })
    if (guard.isFailure()) return failure(guard.value)

    const version: number = this.store.getVersion({ namespace: input.namespace })
    const built = this.keyBuilder.build({ namespace: input.namespace, version, key: input.key })
    if (built.isFailure()) return failure(built.value)

    return success(built.value.physicalKey)
  }

  private ensureConnected(input: { operation: string }): Either<CacheNotInitializedError, true> {
    if (!this.connected) return failure(new CacheNotInitializedError({ operation: input.operation }))

    return success(true)
  }

  private effectiveTtl(input: { ttlInMs?: number; applyJitter?: boolean }): number {
    const base: number = input.ttlInMs ?? this.defaultTtlInMs
    if (input.applyJitter === false || this.jitterRatio === 0) return base

    // Spread expiries so a batch written together does not all die in the same millisecond.
    const spread: number = base * this.jitterRatio
    return Math.max(1, Math.round(base - spread + Math.random() * spread * 2))
  }
}
```

`packages/cache/src/infra/drivers/memory/index.ts`:

```ts
export * from './memory-cache.driver'
export * from './memory.store'
```

Atualize `packages/cache/src/infra/drivers/index.ts`:

```ts
export * from './memory'
export * from './noop'
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos três.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src/infra
git commit -m "feat(cache): add memory driver"
```

---

### Task 13: `GetOrSetCacheProvider` — cache-aside

**Files:**

- Create: `packages/cache/src/application/get-or-set-cache.provider.ts`, `index.ts`
- Modify: `packages/cache/src/index.ts`
- Test: `packages/cache/src/application/__tests__/get-or-set-cache.provider.unit.ts`

**Interfaces:**

- Consumes: `IGetCacheProvider`, `ISetCacheProvider`, `IAcquireLockProvider`, `IReleaseLockProvider` — todos por injeção de construtor, nunca um driver concreto.
- Produces: `class GetOrSetCacheProvider implements IGetOrSetCacheProvider` — `new GetOrSetCacheProvider({ reader, writer, lockAcquirer, lockReleaser, negativeTtlInMs, lockTtlInMs, onCacheError })` — `onCacheError` é **obrigatório**: o fail-open descarta erros de cache, e descartá-los em silêncio não pode ser o default..

Este é o componente que a spec §6 descreve. Ele não conhece driver algum — o mesmo objeto serve `memory`, `noop` e, no plano 2, `valkey`.

- [ ] **Step 1: Escrever o teste que falha**

`packages/cache/src/application/__tests__/get-or-set-cache.provider.unit.ts`:

```ts
import { type Either, failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import {
  CacheConnectionError,
  CacheSource,
  type IAcquireLockProvider,
  type IGetCacheProvider,
  type IReleaseLockProvider,
  type ISetCacheProvider,
  LockNotAcquiredError
} from '../../domain'
import { KeyBuilder } from '../../infra/key-builder'
import { MemoryCacheDriver } from '../../infra/drivers/memory'
import { JsonSerializerStrategy } from '../../infra/serializers'
import { GetOrSetCacheProvider } from '../get-or-set-cache.provider'

const buildDriver = async (): Promise<MemoryCacheDriver> => {
  const driver = new MemoryCacheDriver({
    keyBuilder: new KeyBuilder({ prefix: 'ruguin:test' }),
    serializer: new JsonSerializerStrategy(),
    defaultTtlInMs: 60_000,
    jitterRatio: 0
  })
  await driver.connect()

  return driver
}

const buildProvider = (input: {
  reader: IGetCacheProvider
  writer: ISetCacheProvider
  lockAcquirer: IAcquireLockProvider
  lockReleaser: IReleaseLockProvider
  onCacheError?: (error: unknown) => void
}): GetOrSetCacheProvider =>
  new GetOrSetCacheProvider({
    ...input,
    negativeTtlInMs: 30_000,
    lockTtlInMs: 5000,
    // Required by the constructor on purpose: swallowing cache errors has to be a decision
    // someone makes, not the path of least resistance.
    onCacheError: input.onCacheError ?? ((): void => undefined)
  })

describe('GetOrSetCacheProvider', () => {
  it('runs the loader on a miss and serves the cache on the next call', async () => {
    const driver = await buildDriver()
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: driver
    })
    const loader = vi.fn(async (): Promise<Either<Error, string>> => success('fresh'))

    const first = await provider.getOrSet<string, Error>({ key: '1', namespace: 'user', loader })
    const second = await provider.getOrSet<string, Error>({ key: '1', namespace: 'user', loader })

    if (first.isFailure() || second.isFailure()) throw new Error('expected success')
    expect(first.value).toEqual({ value: 'fresh', source: CacheSource.LOADER })
    expect(second.value).toEqual({ value: 'fresh', source: CacheSource.CACHE })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('caches a null result so a missing record does not hammer the source', async () => {
    const driver = await buildDriver()
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: driver
    })
    const loader = vi.fn(async (): Promise<Either<Error, string | null>> => success(null))

    await provider.getOrSet<string, Error>({ key: 'ghost', namespace: 'user', loader })
    const second = await provider.getOrSet<string, Error>({ key: 'ghost', namespace: 'user', loader })

    if (second.isFailure()) throw new Error('expected success')
    expect(second.value).toEqual({ value: null, source: CacheSource.CACHE })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('propagates only the loader failure', async () => {
    const driver = await buildDriver()
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: driver
    })
    const boom = new Error('database down')

    const result = await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      loader: async () => failure(boom)
    })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBe(boom)
  })

  it('serves the loader when the cache read fails, and reports the error out of band', async () => {
    const driver = await buildDriver()
    const brokenReader: IGetCacheProvider = {
      get: async () => failure(new CacheConnectionError({ operation: 'get' }))
    }
    const seen: unknown[] = []
    const provider = buildProvider({
      reader: brokenReader,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: driver,
      onCacheError: (error) => seen.push(error)
    })

    const result = await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      loader: async () => success('fresh')
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value).toEqual({ value: 'fresh', source: CacheSource.LOADER })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(CacheConnectionError)
  })

  it('still returns the value when the cache write fails', async () => {
    const driver = await buildDriver()
    const brokenWriter: ISetCacheProvider = {
      set: async () => failure(new CacheConnectionError({ operation: 'set' }))
    }
    const provider = buildProvider({
      reader: driver,
      writer: brokenWriter,
      lockAcquirer: driver,
      lockReleaser: driver
    })

    const result = await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      loader: async () => success('fresh')
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toBe('fresh')
  })

  it('re-reads after taking the lock so queued callers do not all hit the source', async () => {
    const driver = await buildDriver()
    let reads = 0
    const reader: IGetCacheProvider = {
      get: async <T>() => {
        reads += 1
        // First read misses; by the time the lock is held another worker has filled it.
        if (reads === 1) return success({ found: false, value: null })
        return success({ found: true, value: 'filled-by-someone-else' as T })
      }
    }
    const loader = vi.fn(async (): Promise<Either<Error, string>> => success('mine'))
    const provider = buildProvider({
      reader,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: driver
    })

    const result = await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      lock: { enabled: true },
      loader
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value).toEqual({ value: 'filled-by-someone-else', source: CacheSource.CACHE })
    expect(loader).not.toHaveBeenCalled()
  })

  it('waits for the lock by default, so a queued caller can still find a filled cache', async () => {
    const driver = await buildDriver()
    const attempts: number[] = []
    const countingLock: IAcquireLockProvider = {
      acquire: async (input) => {
        attempts.push(input.retry?.attempts ?? 1)
        return failure(new LockNotAcquiredError({ lockKey: input.key, attempts: 1 }))
      }
    }
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: countingLock,
      lockReleaser: driver
    })

    await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      lock: { enabled: true },
      loader: async () => success('fresh')
    })

    // Without a wait budget this would be 1, the caller would never queue, and the
    // post-lock re-read below would never get a chance to fire under contention.
    expect(attempts[0]).toBeGreaterThan(1)
  })

  it('runs the loader anyway when the lock cannot be taken', async () => {
    const driver = await buildDriver()
    const busyLock: IAcquireLockProvider = {
      acquire: async () => failure(new LockNotAcquiredError({ lockKey: 'x', attempts: 1 }))
    }
    const loader = vi.fn(async (): Promise<Either<Error, string>> => success('fresh'))
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: busyLock,
      lockReleaser: driver
    })

    const result = await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      lock: { enabled: true },
      loader
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toBe('fresh')
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('releases the lock even when the loader fails', async () => {
    const driver = await buildDriver()
    const released: string[] = []
    const releaser: IReleaseLockProvider = {
      release: async (input) => {
        released.push(input.key)
        return success({ released: true })
      }
    }
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: releaser
    })

    await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      lock: { enabled: true },
      loader: async () => failure(new Error('boom'))
    })

    expect(released).toEqual(['1'])
  })

  it('skips the read and refreshes the cache when forceRefresh is set', async () => {
    const driver = await buildDriver()
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: driver
    })

    await provider.getOrSet<string, Error>({ key: '1', namespace: 'user', loader: async () => success('old') })
    const refreshed = await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      forceRefresh: true,
      loader: async () => success('new')
    })
    const afterwards = await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      loader: async () => success('unused')
    })

    if (refreshed.isFailure() || afterwards.isFailure()) throw new Error('expected success')
    expect(refreshed.value).toEqual({ value: 'new', source: CacheSource.LOADER })
    expect(afterwards.value).toEqual({ value: 'new', source: CacheSource.CACHE })
  })

  it('treats a value rejected by validate as a miss and reloads', async () => {
    const driver = await buildDriver()
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: driver
    })

    await provider.getOrSet<string, Error>({ key: '1', namespace: 'user', loader: async () => success('old-shape') })
    const result = await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      validate: (value) => value === 'new-shape',
      loader: async () => success('new-shape')
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value).toEqual({ value: 'new-shape', source: CacheSource.LOADER })
  })
})
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../get-or-set-cache.provider'`.

- [ ] **Step 3: Implementar**

```ts
// packages/cache/src/application/get-or-set-cache.provider.ts
import { failure, success } from '@ruguin/utils'

import {
  CacheSource,
  type GetOrSetCacheProviderDTO,
  type IAcquireLockProvider,
  type IGetCacheProvider,
  type IGetOrSetCacheProvider,
  type IReleaseLockProvider,
  type ISetCacheProvider
} from '../domain'

type CacheRead<T> = Readonly<{ found: boolean; value: T | null }>

/*
 * How long a caller queues for the fill lock before giving up and loading anyway, and how
 * often it retries within that budget. These have to be named: with no wait at all, whoever
 * loses the race skips straight to the loader, the post-lock re-read never fires, and the
 * stampede protection this class exists for is inert under exactly the contention it targets.
 */
const DEFAULT_LOCK_WAIT_TIMEOUT_MS: number = 3000
const LOCK_POLL_INTERVAL_MS: number = 50

export class GetOrSetCacheProvider implements IGetOrSetCacheProvider {
  private readonly reader: IGetCacheProvider
  private readonly writer: ISetCacheProvider
  private readonly lockAcquirer: IAcquireLockProvider
  private readonly lockReleaser: IReleaseLockProvider
  private readonly negativeTtlInMs: number
  private readonly lockTtlInMs: number
  private readonly onCacheError: (error: unknown) => void

  constructor(input: {
    reader: IGetCacheProvider
    writer: ISetCacheProvider
    lockAcquirer: IAcquireLockProvider
    lockReleaser: IReleaseLockProvider
    negativeTtlInMs: number
    lockTtlInMs: number
    onCacheError: (error: unknown) => void
  }) {
    this.reader = input.reader
    this.writer = input.writer
    this.lockAcquirer = input.lockAcquirer
    this.lockReleaser = input.lockReleaser
    this.negativeTtlInMs = input.negativeTtlInMs
    this.lockTtlInMs = input.lockTtlInMs
    this.onCacheError = input.onCacheError
  }

  public async getOrSet<T, E>(input: GetOrSetCacheProviderDTO.Input<T, E>): GetOrSetCacheProviderDTO.Output<T, E> {
    if (input.forceRefresh !== true) {
      const cached: CacheRead<T> | null = await this.read<T, E>(input)
      if (cached !== null && cached.found) return success({ value: cached.value, source: CacheSource.CACHE })
    }

    let lockToken: string | null = null

    if (input.lock?.enabled === true) {
      lockToken = await this.acquire(input)

      if (lockToken !== null && input.forceRefresh !== true) {
        /*
         * Someone else may have filled the key while we queued for the lock. Without this
         * second read every queued caller would run the loader in turn, trading a parallel
         * stampede for a serial one.
         */
        const refreshed: CacheRead<T> | null = await this.read<T, E>(input)
        if (refreshed !== null && refreshed.found) {
          await this.release({ input, token: lockToken })
          return success({ value: refreshed.value, source: CacheSource.CACHE })
        }
      }
    }

    try {
      const loaded = await input.loader()
      // Not `return loaded`: Failure<E, T | null> is not assignable to Failure<E, OutputSuccess<T>>,
      // because Either carries the success type in its type-guard signatures. Rewrap.
      if (loaded.isFailure()) return failure(loaded.value)

      await this.write({ input, value: loaded.value })

      return success({ value: loaded.value, source: CacheSource.LOADER })
    } finally {
      if (lockToken !== null) await this.release({ input, token: lockToken })
    }
  }

  private async read<T, E>(input: GetOrSetCacheProviderDTO.Input<T, E>): Promise<CacheRead<T> | null> {
    const result = await this.reader.get<T>({
      key: input.key,
      namespace: input.namespace,
      ...(input.consistency === undefined ? {} : { consistency: input.consistency }),
      ...(input.validate === undefined ? {} : { validate: input.validate })
    })

    // Fail-open: a cache outage must never surface as a failure of getOrSet.
    if (result.isFailure()) {
      this.onCacheError(result.value)
      return null
    }

    return result.value
  }

  private async write<T, E>(context: { input: GetOrSetCacheProviderDTO.Input<T, E>; value: T | null }): Promise<void> {
    const ttlInMs: number | undefined =
      context.value === null ? (context.input.negativeTtlInMs ?? this.negativeTtlInMs) : context.input.ttlInMs

    const result = await this.writer.set<T | null>({
      key: context.input.key,
      namespace: context.input.namespace,
      value: context.value,
      ...(ttlInMs === undefined ? {} : { ttlInMs })
    })

    if (result.isFailure()) this.onCacheError(result.value)
  }

  private async acquire<T, E>(input: GetOrSetCacheProviderDTO.Input<T, E>): Promise<string | null> {
    const waitTimeoutInMs: number = input.lock?.waitTimeoutInMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS
    const attempts: number = Math.max(1, Math.ceil(waitTimeoutInMs / LOCK_POLL_INTERVAL_MS))

    const result = await this.lockAcquirer.acquire({
      key: input.key,
      namespace: input.namespace,
      ttlInMs: this.lockTtlInMs,
      retry: { attempts, delayInMs: LOCK_POLL_INTERVAL_MS }
    })

    // A lock we could not take is not fatal: being slow beats being stuck.
    if (result.isFailure()) {
      this.onCacheError(result.value)
      return null
    }

    return result.value.token
  }

  private async release<T, E>(context: { input: GetOrSetCacheProviderDTO.Input<T, E>; token: string }): Promise<void> {
    const result = await this.lockReleaser.release({
      key: context.input.key,
      namespace: context.input.namespace,
      token: context.token
    })

    if (result.isFailure()) this.onCacheError(result.value)
  }
}
```

`packages/cache/src/application/index.ts`:

```ts
export * from './get-or-set-cache.provider'
```

Atualize `packages/cache/src/index.ts`:

```ts
export * from './application'
export * from './domain'
export * from './infra'
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos três.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src
git commit -m "feat(cache): add cache-aside orchestrator with stampede protection"
```

---

### Task 14: `ExecuteWithLockProvider`

**Files:**

- Create: `packages/cache/src/application/execute-with-lock.provider.ts`
- Modify: `packages/cache/src/application/index.ts`
- Test: `packages/cache/src/application/__tests__/execute-with-lock.provider.unit.ts`

**Interfaces:**

- Consumes: `IAcquireLockProvider`, `IReleaseLockProvider`.
- Produces: `class ExecuteWithLockProvider implements IExecuteWithLockProvider` — `new ExecuteWithLockProvider({ lockAcquirer, lockReleaser, onCacheError })` — `onCacheError` obrigatório, mesmo motivo da Task 13..

Ao contrário do `getOrSet`, aqui **não** há fail-open: se o lock não foi obtido, executar a tarefa mesmo assim quebraria a exclusão mútua que o chamador pediu explicitamente.

- [ ] **Step 1: Escrever o teste que falha**

`packages/cache/src/application/__tests__/execute-with-lock.provider.unit.ts`:

```ts
import { type Either, failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import {
  type IAcquireLockProvider,
  type IReleaseLockProvider,
  LockNotAcquiredError,
  LockNotOwnedError
} from '../../domain'
import { ExecuteWithLockProvider } from '../execute-with-lock.provider'

const grantingLock: IAcquireLockProvider = {
  acquire: async () => success({ token: 'token-1', expiresAt: new Date(Date.now() + 5000) })
}

const busyLock: IAcquireLockProvider = {
  acquire: async () => failure(new LockNotAcquiredError({ lockKey: 'job', attempts: 1 }))
}

const noop = (): void => undefined

const recordingReleaser = (): { releaser: IReleaseLockProvider; tokens: () => string[] } => {
  const tokens: string[] = []

  return {
    releaser: {
      release: async (input) => {
        tokens.push(input.token)
        return success({ released: true })
      }
    },
    tokens: () => tokens
  }
}

describe('ExecuteWithLockProvider', () => {
  it('runs the task under the lock and releases it', async () => {
    const { releaser, tokens } = recordingReleaser()
    const provider = new ExecuteWithLockProvider({
      lockAcquirer: grantingLock,
      lockReleaser: releaser,
      onCacheError: noop
    })

    const result = await provider.executeWithLock<string, Error>({
      key: 'job',
      namespace: 'dispatch',
      ttlInMs: 5000,
      task: async () => success('done')
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toBe('done')
    expect(tokens()).toEqual(['token-1'])
  })

  it('refuses to run the task when the lock is busy', async () => {
    const { releaser, tokens } = recordingReleaser()
    const provider = new ExecuteWithLockProvider({ lockAcquirer: busyLock, lockReleaser: releaser, onCacheError: noop })
    const task = vi.fn(async (): Promise<Either<Error, string>> => success('should not run'))

    const result = await provider.executeWithLock<string, Error>({
      key: 'job',
      namespace: 'dispatch',
      ttlInMs: 5000,
      task
    })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBeInstanceOf(LockNotAcquiredError)
    expect(task).not.toHaveBeenCalled()
    expect(tokens()).toEqual([])
  })

  it('releases the lock when the task fails', async () => {
    const { releaser, tokens } = recordingReleaser()
    const provider = new ExecuteWithLockProvider({
      lockAcquirer: grantingLock,
      lockReleaser: releaser,
      onCacheError: noop
    })
    const boom = new Error('task blew up')

    const result = await provider.executeWithLock<string, Error>({
      key: 'job',
      namespace: 'dispatch',
      ttlInMs: 5000,
      task: async () => failure(boom)
    })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBe(boom)
    expect(tokens()).toEqual(['token-1'])
  })

  it('releases the lock when the task throws', async () => {
    const { releaser, tokens } = recordingReleaser()
    const provider = new ExecuteWithLockProvider({
      lockAcquirer: grantingLock,
      lockReleaser: releaser,
      onCacheError: noop
    })

    await expect(
      provider.executeWithLock<string, Error>({
        key: 'job',
        namespace: 'dispatch',
        ttlInMs: 5000,
        task: async () => {
          throw new Error('unexpected')
        }
      })
    ).rejects.toThrow('unexpected')

    expect(tokens()).toEqual(['token-1'])
  })

  it('does not mask the task result when the release fails', async () => {
    const brokenReleaser: IReleaseLockProvider = {
      release: async () => failure(new LockNotOwnedError({ lockKey: 'job' }))
    }
    const seen: unknown[] = []
    const provider = new ExecuteWithLockProvider({
      lockAcquirer: grantingLock,
      lockReleaser: brokenReleaser,
      onCacheError: (error) => seen.push(error)
    })

    const result = await provider.executeWithLock<string, Error>({
      key: 'job',
      namespace: 'dispatch',
      ttlInMs: 5000,
      task: async () => success('done')
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toBe('done')
    expect(seen[0]).toBeInstanceOf(LockNotOwnedError)
  })
})
```

O caso do `throw` importa: uma tarefa que lança (bug, não falha esperada) ainda precisa liberar o lock, senão um bug isolado prende a chave até o TTL vencer.

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../execute-with-lock.provider'`.

- [ ] **Step 3: Implementar**

```ts
// packages/cache/src/application/execute-with-lock.provider.ts
import { failure, success } from '@ruguin/utils'

import {
  type ExecuteWithLockProviderDTO,
  type IAcquireLockProvider,
  type IExecuteWithLockProvider,
  type IReleaseLockProvider
} from '../domain'

export class ExecuteWithLockProvider implements IExecuteWithLockProvider {
  private readonly lockAcquirer: IAcquireLockProvider
  private readonly lockReleaser: IReleaseLockProvider
  private readonly onCacheError: (error: unknown) => void

  constructor(input: {
    lockAcquirer: IAcquireLockProvider
    lockReleaser: IReleaseLockProvider
    onCacheError: (error: unknown) => void
  }) {
    this.lockAcquirer = input.lockAcquirer
    this.lockReleaser = input.lockReleaser
    this.onCacheError = input.onCacheError
  }

  public async executeWithLock<T, E>(
    input: ExecuteWithLockProviderDTO.Input<T, E>
  ): ExecuteWithLockProviderDTO.Output<T, E> {
    const acquired = await this.lockAcquirer.acquire({
      key: input.key,
      namespace: input.namespace,
      ttlInMs: input.ttlInMs,
      ...(input.retry === undefined ? {} : { retry: input.retry })
    })

    // No fail-open here: running the task without the lock would break the mutual
    // exclusion the caller explicitly asked for.
    if (acquired.isFailure()) return failure(acquired.value)

    try {
      const executed = await input.task()
      if (executed.isFailure()) return failure(executed.value)

      return success({ value: executed.value })
    } finally {
      const released = await this.lockReleaser.release({
        key: input.key,
        namespace: input.namespace,
        token: acquired.value.token
      })

      // Reported, never thrown: a failed release must not overwrite the task's own result.
      if (released.isFailure()) this.onCacheError(released.value)
    }
  }
}
```

Atualize `packages/cache/src/application/index.ts`:

```ts
export * from './execute-with-lock.provider'
export * from './get-or-set-cache.provider'
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos três.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src/application
git commit -m "feat(cache): add execute-with-lock orchestrator"
```

---

### Task 15: `CacheProviderFacade` — a instância única com todos os métodos

**Files:**

- Create: `packages/cache/src/application/cache-provider.facade.ts`
- Modify: `packages/cache/src/application/index.ts`
- Test: `packages/cache/src/application/__tests__/cache-provider.facade.unit.ts`

**Interfaces:**

- Consumes: `ICacheDriver`, `IGetOrSetCacheProvider`, `IExecuteWithLockProvider`.
- Produces: `class CacheProviderFacade implements ICacheProvider` — `new CacheProviderFacade({ driver, getOrSetProvider, executeWithLockProvider })`.

Este é o "provider único com todos os métodos" da spec §1.1. Ele **delega** — não reimplementa nada — e é o que permite ao consumidor escolher entre injetar `ICacheProvider` (conveniência) ou um contrato granular como `IGetCacheProvider` (ISP), ambos apontando para a mesma instância.

- [ ] **Step 1: Escrever o teste que falha**

`packages/cache/src/application/__tests__/cache-provider.facade.unit.ts`:

```ts
import { success } from '@ruguin/utils'
import { describe, expect, it } from 'vitest'

import { CacheSource, type IGetCacheProvider } from '../../domain'
import { MemoryCacheDriver } from '../../infra/drivers/memory'
import { KeyBuilder } from '../../infra/key-builder'
import { JsonSerializerStrategy } from '../../infra/serializers'
import { CacheProviderFacade } from '../cache-provider.facade'
import { ExecuteWithLockProvider } from '../execute-with-lock.provider'
import { GetOrSetCacheProvider } from '../get-or-set-cache.provider'

const noop = (): void => undefined

const buildFacade = async (): Promise<CacheProviderFacade> => {
  const driver = new MemoryCacheDriver({
    keyBuilder: new KeyBuilder({ prefix: 'ruguin:test' }),
    serializer: new JsonSerializerStrategy(),
    defaultTtlInMs: 60_000,
    jitterRatio: 0
  })
  await driver.connect()

  return new CacheProviderFacade({
    driver,
    getOrSetProvider: new GetOrSetCacheProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: driver,
      negativeTtlInMs: 30_000,
      lockTtlInMs: 5000,
      onCacheError: noop
    }),
    executeWithLockProvider: new ExecuteWithLockProvider({
      lockAcquirer: driver,
      lockReleaser: driver,
      onCacheError: noop
    })
  })
}

describe('CacheProviderFacade', () => {
  it('exposes leaf operations delegated to the driver', async () => {
    const facade = await buildFacade()

    await facade.set({ key: '1', namespace: 'user', value: 'v', ttlInMs: 1000 })
    const read = await facade.get<string>({ key: '1', namespace: 'user' })

    if (read.isFailure()) throw new Error('expected success')
    expect(read.value).toEqual({ found: true, value: 'v' })
  })

  it('exposes the orchestrated cache-aside on the same instance', async () => {
    const facade = await buildFacade()

    const first = await facade.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      loader: async () => success('fresh')
    })
    const second = await facade.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      loader: async () => success('unused')
    })

    if (first.isFailure() || second.isFailure()) throw new Error('expected success')
    expect(first.value.source).toBe(CacheSource.LOADER)
    expect(second.value.source).toBe(CacheSource.CACHE)
  })

  it('is injectable as a narrow contract, so consumers can honour ISP', async () => {
    const facade = await buildFacade()
    const readOnly: IGetCacheProvider = facade

    const result = await readOnly.get<string>({ key: 'absent', namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.found).toBe(false)
  })

  it('shares one lock namespace between executeWithLock and the driver', async () => {
    const facade = await buildFacade()

    const held = await facade.acquire({ key: 'job', namespace: 'dispatch', ttlInMs: 5000 })
    if (held.isFailure()) throw new Error('expected success')

    const contended = await facade.executeWithLock<string, Error>({
      key: 'job',
      namespace: 'dispatch',
      ttlInMs: 5000,
      task: async () => success('should not run')
    })

    expect(contended.isFailure()).toBe(true)
  })
})
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../cache-provider.facade'`.

- [ ] **Step 3: Implementar**

```ts
// packages/cache/src/application/cache-provider.facade.ts
import {
  type AcquireLockProviderDTO,
  type ConnectProviderDTO,
  type CountScoresProviderDTO,
  type DecrementCounterProviderDTO,
  type DeleteCacheProviderDTO,
  type DisconnectProviderDTO,
  type ExecuteWithLockProviderDTO,
  type ExtendLockProviderDTO,
  type GetCacheProviderDTO,
  type GetCounterProviderDTO,
  type GetOrSetCacheProviderDTO,
  type GetRankProviderDTO,
  type GetScoreProviderDTO,
  type GetTopScoresProviderDTO,
  type HealthCheckProviderDTO,
  type ICacheDriver,
  type ICacheProvider,
  type IExecuteWithLockProvider,
  type IGetOrSetCacheProvider,
  type IncrementCounterProviderDTO,
  type IncrementScoreProviderDTO,
  type InvalidateNamespaceProviderDTO,
  type ReleaseLockProviderDTO,
  type RemoveScoreProviderDTO,
  type ResolveNamespaceVersionProviderDTO,
  type SetCacheProviderDTO,
  type SetIfNotExistsCacheProviderDTO,
  type SetScoreProviderDTO
} from '../domain'

export class CacheProviderFacade implements ICacheProvider {
  private readonly driver: ICacheDriver
  private readonly getOrSetProvider: IGetOrSetCacheProvider
  private readonly executeWithLockProvider: IExecuteWithLockProvider

  constructor(input: {
    driver: ICacheDriver
    getOrSetProvider: IGetOrSetCacheProvider
    executeWithLockProvider: IExecuteWithLockProvider
  }) {
    this.driver = input.driver
    this.getOrSetProvider = input.getOrSetProvider
    this.executeWithLockProvider = input.executeWithLockProvider
  }

  public async get<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    return this.driver.get<T>(input)
  }

  public async set<T>(input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output {
    return this.driver.set<T>(input)
  }

  public async delete(input: DeleteCacheProviderDTO.Input): DeleteCacheProviderDTO.Output {
    return this.driver.delete(input)
  }

  public async setIfNotExists<T>(
    input: SetIfNotExistsCacheProviderDTO.Input<T>
  ): SetIfNotExistsCacheProviderDTO.Output {
    return this.driver.setIfNotExists<T>(input)
  }

  public async getOrSet<T, E>(input: GetOrSetCacheProviderDTO.Input<T, E>): GetOrSetCacheProviderDTO.Output<T, E> {
    return this.getOrSetProvider.getOrSet<T, E>(input)
  }

  public async increment(input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output {
    return this.driver.increment(input)
  }

  public async decrement(input: DecrementCounterProviderDTO.Input): DecrementCounterProviderDTO.Output {
    return this.driver.decrement(input)
  }

  public async getCounter(input: GetCounterProviderDTO.Input): GetCounterProviderDTO.Output {
    return this.driver.getCounter(input)
  }

  public async acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    return this.driver.acquire(input)
  }

  public async release(input: ReleaseLockProviderDTO.Input): ReleaseLockProviderDTO.Output {
    return this.driver.release(input)
  }

  public async extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output {
    return this.driver.extend(input)
  }

  public async executeWithLock<T, E>(
    input: ExecuteWithLockProviderDTO.Input<T, E>
  ): ExecuteWithLockProviderDTO.Output<T, E> {
    return this.executeWithLockProvider.executeWithLock<T, E>(input)
  }

  public async setScore(input: SetScoreProviderDTO.Input): SetScoreProviderDTO.Output {
    return this.driver.setScore(input)
  }

  public async incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output {
    return this.driver.incrementScore(input)
  }

  public async getScore(input: GetScoreProviderDTO.Input): GetScoreProviderDTO.Output {
    return this.driver.getScore(input)
  }

  public async getRank(input: GetRankProviderDTO.Input): GetRankProviderDTO.Output {
    return this.driver.getRank(input)
  }

  public async getTopScores(input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output {
    return this.driver.getTopScores(input)
  }

  public async removeScore(input: RemoveScoreProviderDTO.Input): RemoveScoreProviderDTO.Output {
    return this.driver.removeScore(input)
  }

  public async countScores(input: CountScoresProviderDTO.Input): CountScoresProviderDTO.Output {
    return this.driver.countScores(input)
  }

  public async invalidateNamespace(input: InvalidateNamespaceProviderDTO.Input): InvalidateNamespaceProviderDTO.Output {
    return this.driver.invalidateNamespace(input)
  }

  public async resolveNamespaceVersion(
    input: ResolveNamespaceVersionProviderDTO.Input
  ): ResolveNamespaceVersionProviderDTO.Output {
    return this.driver.resolveNamespaceVersion(input)
  }

  public async connect(): ConnectProviderDTO.Output {
    return this.driver.connect()
  }

  public async disconnect(): DisconnectProviderDTO.Output {
    return this.driver.disconnect()
  }

  public async healthCheck(input?: HealthCheckProviderDTO.Input): HealthCheckProviderDTO.Output {
    return this.driver.healthCheck(input)
  }
}
```

Atualize `packages/cache/src/application/index.ts`:

```ts
export * from './cache-provider.facade'
export * from './execute-with-lock.provider'
export * from './get-or-set-cache.provider'
```

- [ ] **Step 4: Rodar a suíte inteira**

Run: `pnpm --filter @ruguin/cache test:all && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS. Este é o portão final do plano — o pacote está funcional com o driver `memory`.

- [ ] **Step 5: Escrever o `CLAUDE.md` do pacote**

Crie `packages/cache/CLAUDE.md` seguindo o formato de `packages/ddd-kernel/CLAUDE.md`: seções `## Purpose`, `## Structure`, `## Rules`, `## Commands`. Registre em `Rules`:

- TypeScript cru, sem build — exporta `./src/index.ts` direto, sem `dist/`.
- Driver implementa `ICacheDriver` (contratos folha); `getOrSet` e `executeWithLock` vivem em `application/` e servem a qualquer driver.
- Todo caminho retorna `Either`; nada lança para falha esperada.
- `getOrSet` é fail-open por contrato — o tipo `OutputError<E> = E` impede propagar erro de cache.
- O driver `memory` é para dev e teste: seu lock só exclui dentro do mesmo processo.

- [ ] **Step 6: Verificar o monorepo inteiro**

Run: `pnpm check:types && pnpm test`
Expected: PASS — confirma que o pacote novo não quebrou `env`, `utils`, `ddd-kernel` nem `core-server`.

- [ ] **Step 7: Commit**

```bash
git add packages/cache
git commit -m "feat(cache): add cache provider facade composing driver and orchestrators"
```

---

## Verificação final do plano

Ao terminar a Task 15, isto deve ser verdade:

| Afirmação                               | Como confirmar                                          |
| --------------------------------------- | ------------------------------------------------------- |
| O pacote compila e passa lint           | `pnpm --filter @ruguin/cache check:types && check:lint` |
| Toda a suíte unitária passa             | `pnpm --filter @ruguin/cache test:unit`                 |
| `CACHE_DRIVER=valkey` é aceito pelo env | `pnpm --filter @ruguin/env test:unit`                   |
| O monorepo continua verde               | `pnpm check:types && pnpm test`                         |
| Cache-aside previne stampede            | teste "re-reads after taking the lock"                  |
| Fail-open funciona                      | teste "serves the loader when the cache read fails"     |
| Negative caching funciona               | teste "caches a null result"                            |
| Invalidação por namespace funciona      | teste "makes every key under a namespace unreachable"   |
| A cascata de consistência funciona      | 13 casos em `namespace-version.resolver.unit.ts`        |

**Fora deste plano, por design:** driver `valkey`, scripts Lua, broadcast Pub/Sub, decorators de observabilidade e circuit breaker, `CacheFactory`, adapter NestJS e integração no `core-server`. Tudo isso está na spec e vira os planos 2 e 3, que serão escritos com as assinaturas reais que esta fundação produzir.
