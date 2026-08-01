# `@ruguin/cache` — Integração NestJS (Plano 3 de 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expor `@ruguin/cache` ao NestJS por um export path próprio (`@ruguin/cache/nestjs`) — módulo dinâmico com `forRoot`/`forRootAsync`, um token de injeção por contrato, `@InjectCache()`, ciclo de vida de conexão e um health indicator do Terminus — e ligar tudo no `core-server`, de modo que `GET /health` passe a reportar o estado real do Valkey.

**Architecture:** O núcleo do pacote continua agnóstico de framework. Toda a dependência de NestJS mora em `packages/cache/src/nestjs/`, alcançável apenas pelo export `./nestjs`; `@nestjs/common` e `@nestjs/terminus` entram como peers **opcionais**, para que um worker futuro consuma `@ruguin/cache` sem arrastar NestJS. O mapeamento de variáveis de ambiente para a config da factory mora no app, não no pacote.

**Tech Stack:** TypeScript 6.0.3 (pacote) / 5.9 (app), NestJS 11 com adapter Fastify, `@nestjs/terminus` 11.1.1, Vitest 4, pnpm workspaces, Turbo. Valkey 9.1.1 local (master em `localhost:6379`, réplica em `localhost:6380`).

**Spec:** `docs/superpowers/specs/2026-07-31-cache-package-design.md` — §10 (integração NestJS), §10.1 (health indicator), §5.6 (payload do health check).

**Depende de:** `docs/superpowers/plans/2026-07-31-cache-package-foundation.md` (plano 1) e `docs/superpowers/plans/2026-07-31-cache-valkey-driver.md` (plano 2), ambos inteiros concluídos.

**Fora de escopo:** qualquer consumo do cache por regra de negócio; `@ruguin/cache` continua sem um único call site de domínio depois deste plano. O endpoint `/health` ganha um indicador, não um contrato de readiness separado do de liveness.

## Global Constraints

- **TypeScript cru, sem build.** O export `./nestjs` aponta direto para `./src/nestjs/index.ts`. Não existe `dist/`, então o `core-server` compila os **fontes** do pacote com as opções de compilador **dele** — inclusive `exactOptionalPropertyTypes: true`, que o pacote não tinha. A Task 1 existe por isso.
- **Nenhuma exceção para falha esperada.** Todo caminho retorna `Either<F, S>` de `@ruguin/utils`. Cuidado com `return failure(x.value)` e nunca `return x`. A **única** exceção deste plano é a factory de DI do `CacheModule`, que converte a falha de configuração num `throw` de boot — o Nest não tem outro canal, e está documentado na Task 4.
- **Lint deste repo, verificado rodando.** Parâmetro não usado é ERRO (não existe `argsIgnorePattern` para `@typescript-eslint/no-unused-vars`). `async` sem `await` é ERRO. Classe só com membros estáticos é ERRO (`no-extraneous-class`) — um `@Module({})` cai nisso, e a Task 2 resolve com um override de escopo. `sonarjs/deprecation` e `@typescript-eslint/no-deprecated` estão ativos: **`HealthIndicator` do Terminus está deprecado e não pode ser estendido**. `sonarjs/no-redundant-optional` proíbe `x?: T | undefined`, o que elimina "alargar o parâmetro" como saída para `exactOptionalPropertyTypes`. `unicorn/name-replacements` recusa `args` (use `dependencies`). `unicorn/class-reference-in-static-methods` exige `module: this`, não `module: CacheModule`. `@typescript-eslint/only-throw-error` recusa `throw` de `BaseError`, que não estende `Error`. Imports e exports em ordem alfabética (`import-sort`); `export namespace ...DTO` é a convenção (`no-namespace` está off).
- **Duas cópias de `@nestjs/*`.** Com `@nestjs/common` e `@nestjs/terminus` declarados em `packages/cache` e em `apps/core-server`, o pnpm resolve dois diretórios distintos em `.pnpm` (diferem só pelo peer `supports-color`). Metadados do `@nestjs/common` são chaves de string, então convivem; **classes usadas como token de DI, não**. Nada do Terminus pode ser injetado dentro do pacote — Task 7.
- **Testes:** unitários em `src/**/__tests__/**/*.unit.ts`, integração em `*.int.ts`, e2e (só no `core-server`) em `*.e2e.ts`. O `vitest.config.ts` de `packages/cache` **não precisa de mudança**: o transform oxc do Vite já emite `design:paramtypes`, verificado com uma sonda `Reflect.getMetadata`.
- **Commits:** Conventional Commits, escopo `cache`, `core-server` ou `env`. **Nunca** adicionar trailer `Co-Authored-By`.

## File Structure

| Arquivo                                               | Responsabilidade                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/cache/tsconfig.json`                        | Liga `exactOptionalPropertyTypes`, para o pacote falhar onde o erro nasce                  |
| `packages/cache/package.json`                         | Export `./nestjs`, peers opcionais de NestJS e as devDeps que os tornam verificáveis       |
| `packages/cache/eslint.config.ts`                     | Desliga `no-extraneous-class` só em `src/nestjs/**`                                        |
| `packages/cache/src/nestjs/cache.tokens.ts`           | Um `Symbol` por contrato, mais o composto, mais a lista que o módulo usa para os aliases   |
| `packages/cache/src/nestjs/cache-module.options.ts`   | `CacheModuleOptions`, `CacheModuleAsyncOptions` e a config que a factory recebe            |
| `packages/cache/src/nestjs/inject-cache.decorator.ts` | `@InjectCache()` — açúcar para `@Inject(CACHE_PROVIDER)`                                   |
| `packages/cache/src/nestjs/cache.module.ts`           | Módulo dinâmico: providers, aliases, `isGlobal` e o ciclo de vida da conexão               |
| `packages/cache/src/nestjs/cache-health.indicator.ts` | Converte o payload de `healthCheck()` no formato do Terminus, sem depender dele em runtime |
| `packages/cache/src/nestjs/index.ts`                  | Barrel do export `./nestjs`                                                                |
| `packages/env/package.json`                           | Export `./cache`, para o app não arrastar todos os schemas                                 |
| `apps/core-server/src/cache/cache-module-options.ts`  | Costura entre o ambiente validado e a config da factory                                    |
| `apps/core-server/src/app.module.ts`                  | Registra o `CacheModule` global                                                            |
| `apps/core-server/src/health/health.module.ts`        | Declara o `CacheHealthIndicator` no módulo que já importa o `TerminusModule`               |
| `apps/core-server/src/health/health.controller.ts`    | `check([])` vira `check([() => this.cacheHealth.isHealthy('cache')])`                      |
| `apps/core-server/src/main.ts`                        | `enableShutdownHooks()`, sem o qual o `disconnect()` nunca roda num SIGTERM                |

---

### Task 1: `@ruguin/cache` compilável sob `exactOptionalPropertyTypes`

**Files:**

- Modify: `packages/cache/tsconfig.json`
- Modify: `packages/cache/src/infra/drivers/memory/memory-cache.driver.ts`
- Modify: `packages/cache/src/infra/drivers/memory/memory.store.ts`
- Modify: `packages/cache/src/infra/drivers/valkey/operations/key-value.operations.ts`

**Interfaces:**

- Consumes: nada.
- Produces: `packages/cache` compila com a mesma severidade que o `core-server` aplica aos seus fontes.

O pacote não tem build, então `apps/core-server` compila `packages/cache/src/**` com o `tsconfig` **dele**, que estende `@ruguin/typescript-config/nestjs.json` e liga `exactOptionalPropertyTypes: true`. São nove erros `TS2379`, todos do mesmo formato: passar `{ ttlInMs: input.ttlInMs }` onde `input.ttlInMs` é `number | undefined` e o alvo declara `ttlInMs?: number`.

A saída óbvia — declarar `ttlInMs?: number | undefined` no alvo — está fechada: `sonarjs/no-redundant-optional` recusa a combinação `?` mais `| undefined`. Sobra o spread condicional, que é o que o resto do pacote já faz (`create-valkey-driver.ts` monta `connectionOptions` assim).

Ligar a opção no `tsconfig.json` do pacote é o ponto: sem isso, o próximo `TS2379` continua nascendo aqui e aparecendo no `check:types` do app, a três diretórios de distância de onde foi escrito.

- [ ] **Step 1: Reproduzir o erro antes de corrigir**

Em `packages/cache/tsconfig.json`, substitua o arquivo inteiro por:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "exactOptionalPropertyTypes": true
  },
  "exclude": ["node_modules"],
  "extends": "@ruguin/typescript-config/base.json",
  "include": ["**/*.ts"]
}
```

Run: `pnpm --filter @ruguin/cache check:types`
Expected: 9 erros `TS2379` em 3 arquivos — `memory-cache.driver.ts` (5), `memory.store.ts` (2), `key-value.operations.ts` (2).

- [ ] **Step 2: Corrigir `memory-cache.driver.ts` — TTL e jitter do `set`**

Cada bloco daqui até o Step 5 é o método **inteiro** já corrigido; substitua o método de mesmo nome por ele.

```ts
  public set<T>(input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'set' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    const serialized = this.serializer.serialize({ value: input.value })
    if (serialized.isFailure()) return Promise.resolve(failure(serialized.value))

    const ttlInMs: number = this.effectiveTtl({
      ...(input.ttlInMs !== undefined && { ttlInMs: input.ttlInMs }),
      ...(input.applyJitter !== undefined && { applyJitter: input.applyJitter })
    })
    this.store.setValue({ key: key.value, serialized: serialized.value.serialized, ttlInMs })

    const expiresAt: Date = new Date(Date.now() + ttlInMs)

    return Promise.resolve(success({ expiresAt }))
  }
```

- [ ] **Step 3: Corrigir `memory-cache.driver.ts` — janela do contador**

```ts
  public increment(input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'increment' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    return Promise.resolve(
      success({
        // The store anchors this expiry to the first increment, which is what windowInMs means.
        value: this.store.incrementCounter({
          key: key.value,
          by: input.by ?? 1,
          ...(input.windowInMs !== undefined && { ttlInMs: input.windowInMs })
        })
      })
    )
  }
```

- [ ] **Step 4: Corrigir `memory-cache.driver.ts` — os três de score**

```ts
  public setScore(input: SetScoreProviderDTO.Input): SetScoreProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'setScore' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    return Promise.resolve(
      success({
        created: this.store.setScore({
          key: key.value,
          member: input.member,
          score: input.score,
          ...(input.ttlInMs !== undefined && { ttlInMs: input.ttlInMs })
        })
      })
    )
  }
```

```ts
  public incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'incrementScore' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    return Promise.resolve(
      success({
        score: this.store.incrementScore({
          key: key.value,
          member: input.member,
          by: input.by,
          ...(input.ttlInMs !== undefined && { ttlInMs: input.ttlInMs })
        })
      })
    )
  }
```

```ts
  public getTopScores(input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output {
    const key = this.physicalKey({ namespace: input.namespace, key: input.key, operation: 'getTopScores' })
    if (key.isFailure()) return Promise.resolve(failure(key.value))

    return Promise.resolve(
      success({
        entries: this.store.getTopScores({
          key: key.value,
          limit: input.limit,
          ...(input.offset !== undefined && { offset: input.offset })
        })
      })
    )
  }
```

- [ ] **Step 5: Corrigir `memory.store.ts`**

Os dois métodos que chamam `membersOf`:

```ts
  public setScore(input: { key: string; member: string; score: number; ttlInMs?: number }): boolean {
    const members: Map<string, number> = this.membersOf({
      key: input.key,
      ...(input.ttlInMs !== undefined && { ttlInMs: input.ttlInMs })
    })
    const isNewMember = !members.has(input.member)

    members.set(input.member, input.score)

    return isNewMember
  }
```

```ts
  public incrementScore(input: { key: string; member: string; by: number; ttlInMs?: number }): number {
    const members: Map<string, number> = this.membersOf({
      key: input.key,
      ...(input.ttlInMs !== undefined && { ttlInMs: input.ttlInMs })
    })
    const next: number = (members.get(input.member) ?? 0) + input.by

    members.set(input.member, next)

    return next
  }
```

- [ ] **Step 6: Corrigir `key-value.operations.ts`**

As duas chamadas a `decode`. O fim de `getEventual`:

```ts
    if (raw.isFailure()) return failure(raw.value)
    if (raw.value === null) return success(MISS)

    return this.decode<T>({ raw: raw.value, ...(input.validate !== undefined && { validate: input.validate }) })
  }
```

E o fim de `getStrong`:

```ts
    const raw: string | undefined = reply[1]
    if (raw === undefined) return success(MISS)

    return this.decode<T>({ raw, ...(input.validate !== undefined && { validate: input.validate }) })
  }
```

- [ ] **Step 7: Verificar**

Run: `pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint && pnpm --filter @ruguin/cache test:all`
Expected: sem erro; 242 testes verdes (exige `redis` e `redis-replica` no ar para os de integração).

- [ ] **Step 8: Commit**

```bash
git add packages/cache/tsconfig.json packages/cache/src
git commit -m "fix(cache): compile cleanly under exactOptionalPropertyTypes"
```

---

### Task 2: Andaime do export `./nestjs` e os tokens

**Files:**

- Modify: `packages/cache/package.json`
- Modify: `packages/cache/eslint.config.ts`
- Create: `packages/cache/src/nestjs/cache.tokens.ts`
- Create: `packages/cache/src/nestjs/__tests__/cache.tokens.unit.ts`
- Create: `packages/cache/src/nestjs/index.ts`

**Interfaces:**

- Consumes: nada.
- Produces: `@ruguin/cache/nestjs` resolvível; 25 tokens `Symbol` exportados, mais `CONTRACT_TOKENS` (24) e `CACHE_MODULE_OPTIONS`.

`@nestjs/common` e `@nestjs/terminus` entram como **peers opcionais mais devDependencies**. As duas coisas: peer opcional é o que declara "quem usar `./nestjs` traz o seu"; devDependency é o que dá ao `tsc` e ao `vitest` deste pacote algo para resolver. `@nestjs/core`, `@nestjs/testing`, `reflect-metadata` e `rxjs` são só de teste — `Test.createTestingModule` precisa dos dois primeiros, e o terceiro é importado explicitamente no teste do módulo.

Nada de `@swc/core` nem `unplugin-swc`: o `core-server` precisa deles porque o `nest build` usa SWC, mas aqui o transform padrão do Vite já emite `design:paramtypes` — verificado com `Reflect.getMetadata('design:paramtypes', …)` sobre uma classe `@Injectable()` de sonda. Duas dependências que não precisam existir.

- [ ] **Step 1: Declarar o export path, os peers e as devDependencies**

Em `packages/cache/package.json`, o bloco `exports` ganha uma entrada:

```json
  "exports": {
    ".": "./src/index.ts",
    "./nestjs": "./src/nestjs/index.ts"
  },
```

E `devDependencies` cresce, seguido de `peerDependencies` e `peerDependenciesMeta` — nessa ordem, que é a que o `prettier-plugin-packagejson` impõe; escrevê-los antes de `devDependencies` faz o `prettier --check` do pre-commit falhar:

```json
  "devDependencies": {
    "@nestjs/common": "^11.0.1",
    "@nestjs/core": "^11.0.1",
    "@nestjs/terminus": "^11.1.1",
    "@nestjs/testing": "^11.0.1",
    "@ruguin/eslint-config": "workspace:*",
    "@ruguin/typescript-config": "workspace:*",
    "@types/node": "^26.1.2",
    "npm-check-updates": "23.0.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "typescript": "6.0.3",
    "vitest": "^4.1.10"
  },
  "peerDependencies": {
    "@nestjs/common": "^11.0.1",
    "@nestjs/terminus": "^11.1.1"
  },
  "peerDependenciesMeta": {
    "@nestjs/common": {
      "optional": true
    },
    "@nestjs/terminus": {
      "optional": true
    }
  }
```

- [ ] **Step 2: Instalar**

Run: `pnpm install`
Expected: sucesso. Os avisos de peer sobre `chokidar`/`@swc/cli` e `eslint`/`eslint-plugin-jsx-a11y` são pré-existentes e não têm relação com o cache.

- [ ] **Step 3: Abrir `no-extraneous-class` só onde o NestJS obriga**

Substitua `packages/cache/eslint.config.ts` inteiro:

```ts
import { defineConfig } from '@ruguin/eslint-config'

export default defineConfig(
  {},
  {
    /*
     * A @Module() class carries its metadata on the class itself; NestJS has no other place to put
     * it. Scoped to src/nestjs so the rest of the package keeps the rule that made CacheFactory an
     * object literal instead of a class of statics.
     */
    files: ['src/nestjs/**/*.ts'],
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off'
    }
  }
)
```

- [ ] **Step 4: Escrever o teste dos tokens (RED)**

Crie `packages/cache/src/nestjs/__tests__/cache.tokens.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { CACHE_MODULE_OPTIONS, CACHE_PROVIDER, CONTRACT_TOKENS } from '../cache.tokens'

describe('cache tokens', () => {
  it('gives every contract its own symbol', () => {
    expect(new Set(CONTRACT_TOKENS).size).toBe(CONTRACT_TOKENS.length)
  })

  /*
   * CACHE_PROVIDER is the alias target, so listing it among the aliases would make the module
   * register a provider that resolves to itself.
   */
  it('keeps the composite and the internal options token out of the alias list', () => {
    expect(CONTRACT_TOKENS).not.toContain(CACHE_PROVIDER)
    expect(CONTRACT_TOKENS).not.toContain(CACHE_MODULE_OPTIONS)
  })

  it('covers the twenty-four granular contracts of ICacheDriver plus the two orchestrators', () => {
    expect(CONTRACT_TOKENS).toHaveLength(24)
  })
})
```

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: falha por não encontrar `../cache.tokens`.

- [ ] **Step 5: Criar os tokens (GREEN)**

Crie `packages/cache/src/nestjs/cache.tokens.ts`:

```ts
/*
 * One token per contract, plus the composite. Every one of them resolves to the same instance —
 * the aliasing lives in cache.module.ts. The point is not to hand out different objects; it is to
 * let the injection point name exactly the slice it depends on, so a service that only reads a key
 * declares IGetCacheProvider and cannot quietly grow a call to invalidateNamespace.
 *
 * Symbols rather than strings: a string token collides silently across packages, and the collision
 * surfaces as the wrong provider being injected rather than as an error.
 */

/** `ICacheProvider` — the whole surface. Convenience, not the default choice. */
export const CACHE_PROVIDER = Symbol('CACHE_PROVIDER')

export const ACQUIRE_LOCK_PROVIDER = Symbol('ACQUIRE_LOCK_PROVIDER')
export const CONNECT_PROVIDER = Symbol('CONNECT_PROVIDER')
export const COUNT_SCORES_PROVIDER = Symbol('COUNT_SCORES_PROVIDER')
export const DECREMENT_COUNTER_PROVIDER = Symbol('DECREMENT_COUNTER_PROVIDER')
export const DELETE_CACHE_PROVIDER = Symbol('DELETE_CACHE_PROVIDER')
export const DISCONNECT_PROVIDER = Symbol('DISCONNECT_PROVIDER')
export const EXECUTE_WITH_LOCK_PROVIDER = Symbol('EXECUTE_WITH_LOCK_PROVIDER')
export const EXTEND_LOCK_PROVIDER = Symbol('EXTEND_LOCK_PROVIDER')
export const GET_CACHE_PROVIDER = Symbol('GET_CACHE_PROVIDER')
export const GET_COUNTER_PROVIDER = Symbol('GET_COUNTER_PROVIDER')
export const GET_OR_SET_CACHE_PROVIDER = Symbol('GET_OR_SET_CACHE_PROVIDER')
export const GET_RANK_PROVIDER = Symbol('GET_RANK_PROVIDER')
export const GET_SCORE_PROVIDER = Symbol('GET_SCORE_PROVIDER')
export const GET_TOP_SCORES_PROVIDER = Symbol('GET_TOP_SCORES_PROVIDER')
export const HEALTH_CHECK_PROVIDER = Symbol('HEALTH_CHECK_PROVIDER')
export const INCREMENT_COUNTER_PROVIDER = Symbol('INCREMENT_COUNTER_PROVIDER')
export const INCREMENT_SCORE_PROVIDER = Symbol('INCREMENT_SCORE_PROVIDER')
export const INVALIDATE_NAMESPACE_PROVIDER = Symbol('INVALIDATE_NAMESPACE_PROVIDER')
export const RELEASE_LOCK_PROVIDER = Symbol('RELEASE_LOCK_PROVIDER')
export const REMOVE_SCORE_PROVIDER = Symbol('REMOVE_SCORE_PROVIDER')
export const RESOLVE_NAMESPACE_VERSION_PROVIDER = Symbol('RESOLVE_NAMESPACE_VERSION_PROVIDER')
export const SET_CACHE_PROVIDER = Symbol('SET_CACHE_PROVIDER')
export const SET_IF_NOT_EXISTS_CACHE_PROVIDER = Symbol('SET_IF_NOT_EXISTS_CACHE_PROVIDER')
export const SET_SCORE_PROVIDER = Symbol('SET_SCORE_PROVIDER')

/** Internal wiring: the options `forRoot`/`forRootAsync` received, before defaults are applied. */
export const CACHE_MODULE_OPTIONS = Symbol('CACHE_MODULE_OPTIONS')

/*
 * Every token above except CACHE_PROVIDER and CACHE_MODULE_OPTIONS. The module aliases each one to
 * CACHE_PROVIDER; keeping the list here means a new contract is wired by adding a single line.
 */
export const CONTRACT_TOKENS: readonly symbol[] = [
  ACQUIRE_LOCK_PROVIDER,
  CONNECT_PROVIDER,
  COUNT_SCORES_PROVIDER,
  DECREMENT_COUNTER_PROVIDER,
  DELETE_CACHE_PROVIDER,
  DISCONNECT_PROVIDER,
  EXECUTE_WITH_LOCK_PROVIDER,
  EXTEND_LOCK_PROVIDER,
  GET_CACHE_PROVIDER,
  GET_COUNTER_PROVIDER,
  GET_OR_SET_CACHE_PROVIDER,
  GET_RANK_PROVIDER,
  GET_SCORE_PROVIDER,
  GET_TOP_SCORES_PROVIDER,
  HEALTH_CHECK_PROVIDER,
  INCREMENT_COUNTER_PROVIDER,
  INCREMENT_SCORE_PROVIDER,
  INVALIDATE_NAMESPACE_PROVIDER,
  RELEASE_LOCK_PROVIDER,
  REMOVE_SCORE_PROVIDER,
  RESOLVE_NAMESPACE_VERSION_PROVIDER,
  SET_CACHE_PROVIDER,
  SET_IF_NOT_EXISTS_CACHE_PROVIDER,
  SET_SCORE_PROVIDER
]
```

- [ ] **Step 6: Criar o barrel**

Crie `packages/cache/src/nestjs/index.ts`:

```ts
export * from './cache.tokens'
```

- [ ] **Step 7: Verificar**

Run: `pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint && pnpm --filter @ruguin/cache test:unit`
Expected: sem erro; 3 testes novos verdes.

- [ ] **Step 8: Commit**

```bash
git add packages/cache/package.json packages/cache/eslint.config.ts packages/cache/src/nestjs pnpm-lock.yaml
git commit -m "feat(cache): add a nestjs export path with one injection token per contract"
```

---

### Task 3: Opções do módulo e `@InjectCache()`

**Files:**

- Create: `packages/cache/src/nestjs/cache-module.options.ts`
- Create: `packages/cache/src/nestjs/inject-cache.decorator.ts`
- Modify: `packages/cache/src/nestjs/index.ts`

**Interfaces:**

- Consumes: `CacheFactoryDTO.Config` de `../factory`, `OnCacheError` de `../application`, `CACHE_PROVIDER`.
- Produces: `CacheModuleFactoryOptions`, `CacheModuleOptions`, `CacheModuleAsyncOptions`, `InjectCache`.

A spec §10 ilustra o registro como `CacheModule.forRoot({ isGlobal: true })`. Isso não pode ser literal: `CacheFactoryDTO.Config` exige `prefix`, `defaultTtlInMs` e mais uma dúzia de campos sem default, e um cache cujo prefixo foi escolhido por omissão é um cache que ninguém consegue raciocinar a partir do call site. As opções são a config da factory mais `isGlobal`.

A **única** exceção é `onCacheError`. Reportar uma falha de cache engolida é exatamente o que um adapter de framework sabe fazer e o núcleo agnóstico não — o módulo cai num `Logger` do Nest quando o consumidor não passa nada.

`(...dependencies: never[])` é o tipo de parâmetro do `useFactory`: é a única lista à qual qualquer assinatura de factory é atribuível sob `strictFunctionTypes`, e não arrasta `any` para a superfície pública. O nome `dependencies` em vez de `args` é exigência do `unicorn/name-replacements`.

- [ ] **Step 1: Criar os tipos de opção**

Crie `packages/cache/src/nestjs/cache-module.options.ts`:

```ts
import { type FactoryProvider, type ModuleMetadata } from '@nestjs/common'

import { type OnCacheError } from '../application'
import { type CacheFactoryDTO } from '../factory'

/*
 * The factory's own config minus onCacheError, which the module can supply for you: reporting a
 * swallowed cache failure is exactly the kind of thing a framework adapter knows how to do and the
 * framework-agnostic core does not. Everything else stays required — a cache whose prefix or TTL
 * was silently defaulted is a cache nobody can reason about from the call site.
 */
export type CacheModuleFactoryOptions = Readonly<
  Omit<CacheFactoryDTO.Config, 'onCacheError'> & { onCacheError?: OnCacheError }
>

export type CacheModuleOptions = Readonly<CacheModuleFactoryOptions & { isGlobal?: boolean }>

/*
 * `never[]` rather than `any[]`: it is the one parameter list every factory shape is assignable to
 * under strictFunctionTypes, and it keeps `any` out of the public surface.
 */
export type CacheModuleAsyncOptions = Readonly<{
  imports?: NonNullable<ModuleMetadata['imports']>
  inject?: NonNullable<FactoryProvider['inject']>
  isGlobal?: boolean
  useFactory: (...dependencies: never[]) => CacheModuleFactoryOptions | Promise<CacheModuleFactoryOptions>
}>
```

`NonNullable<...>` em `imports` e `inject` não é decoração: os tipos do Nest já incluem `undefined`, e `?: T | undefined` dispara `sonarjs/no-redundant-optional`.

- [ ] **Step 2: Criar o decorator**

Crie `packages/cache/src/nestjs/inject-cache.decorator.ts`:

```ts
import { Inject } from '@nestjs/common'

import { CACHE_PROVIDER } from './cache.tokens'

/*
 * Sugar for @Inject(CACHE_PROVIDER). It exists so the common case reads as a declaration rather
 * than as a token lookup; anyone wanting a narrower contract reaches for @Inject(GET_CACHE_PROVIDER)
 * and friends directly, which is the whole reason the granular tokens exist.
 */
export const InjectCache = (): ReturnType<typeof Inject> => Inject(CACHE_PROVIDER)
```

- [ ] **Step 3: Atualizar o barrel**

`packages/cache/src/nestjs/index.ts` inteiro (ordem alfabética exigida por `import-sort/exports` — `cache.tokens` antes de `cache-module.options` porque `.` ordena antes de `-`):

```ts
export * from './cache.tokens'
export * from './cache-module.options'
export * from './inject-cache.decorator'
```

- [ ] **Step 4: Verificar**

Run: `pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: sem erro.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src/nestjs
git commit -m "feat(cache): add nestjs module option types and the InjectCache decorator"
```

---

### Task 4: `CacheModule.forRoot`

**Files:**

- Create: `packages/cache/src/nestjs/cache.module.ts`
- Create: `packages/cache/src/nestjs/__tests__/cache.module.unit.ts`
- Modify: `packages/cache/src/nestjs/index.ts`

**Interfaces:**

- Consumes: `CacheFactory.create`, `CacheModuleOptions`, os tokens.
- Produces: `CacheModule.forRoot(options): DynamicModule`, com `CACHE_PROVIDER` e os 24 aliases exportados.

Os aliases usam `useExisting`, não `useClass` nem uma segunda `useFactory`. Isso é o contrato inteiro deste plano: injetar `IGetCacheProvider` e injetar `ICacheProvider` tem que devolver **o mesmo objeto**, senão o breaker, o memo de versão de namespace e o pool de conexões existiriam em duplicata sem que ninguém percebesse.

`CacheFactory.create` devolve `Either`, e aqui — só aqui — ele vira `throw`. O Nest não tem outro canal de falha para uma factory de provider, e um container que entrega um cache pela metade é pior que um que se recusa a subir: URL de master ausente com driver `valkey` é erro de programação de boot, da mesma família que variável de ambiente faltando. O erro de domínio viaja em `cause` porque `BaseError` não estende `Error` e `@typescript-eslint/only-throw-error` (com razão) recusa lançá-lo direto.

- [ ] **Step 1: Escrever os testes do `forRoot` (RED)**

Crie `packages/cache/src/nestjs/__tests__/cache.module.unit.ts`:

```ts
import 'reflect-metadata'

import { Inject, Injectable } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { describe, expect, it } from 'vitest'

import { CacheConsistency, CacheDriver, type ICacheProvider, type IGetCacheProvider } from '../../domain'
import { CacheModule } from '../cache.module'
import { CACHE_PROVIDER, CONTRACT_TOKENS, GET_CACHE_PROVIDER } from '../cache.tokens'
import { type CacheModuleFactoryOptions } from '../cache-module.options'
import { InjectCache } from '../inject-cache.decorator'

const baseOptions = (overrides: Partial<CacheModuleFactoryOptions> = {}): CacheModuleFactoryOptions => ({
  breaker: { failureThreshold: 5, resetTimeoutInMs: 10_000 },
  defaultConsistency: CacheConsistency.EVENTUAL,
  defaultTtlInMs: 300_000,
  driver: CacheDriver.MEMORY,
  invalidationBroadcast: false,
  jitterRatio: 0,
  lockTtlInMs: 5000,
  namespaceVersionLocalTtlInMs: 5000,
  negativeTtlInMs: 30_000,
  observability: false,
  operationTimeoutInMs: 500,
  prefix: 'ruguin:test',
  replicationLagThresholdInBytes: 1_048_576,
  ...overrides
})

@Injectable()
class ReaderService {
  public readonly reader: IGetCacheProvider

  constructor(@Inject(GET_CACHE_PROVIDER) reader: IGetCacheProvider) {
    this.reader = reader
  }
}

@Injectable()
class FacadeService {
  public readonly cache: ICacheProvider

  constructor(@InjectCache() cache: ICacheProvider) {
    this.cache = cache
  }
}

describe('CacheModule.forRoot', () => {
  it('resolves every contract token to the one instance the factory produced', async () => {
    const moduleReference = await Test.createTestingModule({ imports: [CacheModule.forRoot(baseOptions())] }).compile()

    const composite = moduleReference.get<ICacheProvider>(CACHE_PROVIDER)
    for (const token of CONTRACT_TOKENS) {
      expect(moduleReference.get(token)).toBe(composite)
    }

    await moduleReference.close()
  })

  it('serves both the granular and the composite injection points from that same instance', async () => {
    const moduleReference = await Test.createTestingModule({
      imports: [CacheModule.forRoot(baseOptions())],
      providers: [FacadeService, ReaderService]
    }).compile()

    const composite = moduleReference.get<ICacheProvider>(CACHE_PROVIDER)

    expect(moduleReference.get(ReaderService).reader).toBe(composite)
    expect(moduleReference.get(FacadeService).cache).toBe(composite)

    await moduleReference.close()
  })

  it('marks the module global only when asked', () => {
    expect(CacheModule.forRoot(baseOptions()).global).toBe(false)
    expect(CacheModule.forRoot({ ...baseOptions(), isGlobal: true }).global).toBe(true)
  })

  /*
   * isGlobal is a module-registration concern; letting it reach CacheFactory.create would mean the
   * factory silently accepting a field it knows nothing about.
   */
  it('keeps isGlobal out of the options handed to the factory', async () => {
    const moduleReference = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ ...baseOptions(), isGlobal: true })]
    }).compile()

    expect(moduleReference.get<ICacheProvider>(CACHE_PROVIDER)).toBeDefined()

    await moduleReference.close()
  })

  it('refuses to build when the factory rejects the configuration', async () => {
    const compiling = Test.createTestingModule({
      imports: [CacheModule.forRoot(baseOptions({ driver: CacheDriver.VALKEY }))]
    }).compile()

    await expect(compiling).rejects.toThrow('InvalidCacheConfigError')
  })
})
```

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: falha por não encontrar `../cache.module`.

- [ ] **Step 2: Criar o módulo (GREEN)**

Crie `packages/cache/src/nestjs/cache.module.ts`:

```ts
import { type DynamicModule, Logger, Module, type Provider } from '@nestjs/common'

import { type OnCacheError } from '../application'
import { type ICacheProvider } from '../domain'
import { CacheFactory } from '../factory'

import { CACHE_MODULE_OPTIONS, CACHE_PROVIDER, CONTRACT_TOKENS } from './cache.tokens'
import { type CacheModuleFactoryOptions, type CacheModuleOptions } from './cache-module.options'

const LOGGER_CONTEXT = 'CacheModule'

const defaultOnCacheError = (): OnCacheError => {
  const logger = new Logger(LOGGER_CONTEXT)

  return (input) => {
    logger.warn(`cache ${input.operation} failed on ${input.namespace}:${input.key}`, input.error)
  }
}

/*
 * The one place the package's Either is consumed rather than propagated. Nest's DI has no failure
 * channel other than a throw, and a container that hands out a half-built cache is worse than one
 * that refuses to start: a missing master url is a boot-time programming error, in the same family
 * as an absent environment variable. The domain error travels as `cause` — BaseError does not
 * extend Error, so it cannot be thrown as-is.
 */
const buildCacheProvider = (): Provider => ({
  provide: CACHE_PROVIDER,
  useFactory: (options: CacheModuleFactoryOptions): ICacheProvider => {
    const created = CacheFactory.create({ ...options, onCacheError: options.onCacheError ?? defaultOnCacheError() })
    if (created.isFailure()) {
      throw new Error(`@ruguin/cache: ${created.value.name}: ${created.value.message}`, { cause: created.value })
    }

    return created.value
  },
  inject: [CACHE_MODULE_OPTIONS]
})

/* useExisting, not useClass or a second useFactory: the aliases must resolve to the same object. */
const buildContractAliases = (): Provider[] =>
  CONTRACT_TOKENS.map((token) => ({ provide: token, useExisting: CACHE_PROVIDER }))

@Module({})
export class CacheModule {
  public static forRoot(options: CacheModuleOptions): DynamicModule {
    const { isGlobal = false, ...factoryOptions } = options

    return {
      exports: [CACHE_PROVIDER, ...CONTRACT_TOKENS],
      global: isGlobal,
      module: this,
      providers: [
        { provide: CACHE_MODULE_OPTIONS, useValue: factoryOptions },
        buildCacheProvider(),
        ...buildContractAliases()
      ]
    }
  }
}
```

`module: this` e não `module: CacheModule`: `unicorn/class-reference-in-static-methods`. A classe ainda não tem construtor — ele só aparece na Task 6, porque um `private readonly cache` declarado antes de ser lido é `TS6133` sob `noUnusedLocals`. Sem membros de instância a classe só sobrevive ao lint por causa do override da Task 2.

- [ ] **Step 3: Atualizar o barrel**

`packages/cache/src/nestjs/index.ts`:

```ts
export * from './cache.module'
export * from './cache.tokens'
export * from './cache-module.options'
export * from './inject-cache.decorator'
```

- [ ] **Step 4: Verificar**

Run: `pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint && pnpm --filter @ruguin/cache test:unit`
Expected: sem erro; 5 testes novos verdes.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src/nestjs
git commit -m "feat(cache): add CacheModule.forRoot aliasing every contract to one instance"
```

---

### Task 5: `CacheModule.forRootAsync`

**Files:**

- Modify: `packages/cache/src/nestjs/cache.module.ts`
- Modify: `packages/cache/src/nestjs/__tests__/cache.module.unit.ts`

**Interfaces:**

- Consumes: `CacheModuleAsyncOptions`.
- Produces: `CacheModule.forRootAsync(options): DynamicModule`.

`forRootAsync` existe para o caso em que a config só é conhecida depois que outro módulo resolveu — um `ConfigModule`, um segredo buscado no boot. Os providers são os mesmos; muda só de onde `CACHE_MODULE_OPTIONS` vem.

- [ ] **Step 1: Escrever os testes (RED)**

Acrescente ao fim de `packages/cache/src/nestjs/__tests__/cache.module.unit.ts`:

```ts
@Module({ providers: [{ provide: 'PREFIX', useValue: 'ruguin:async' }], exports: ['PREFIX'] })
class PrefixModule {}

describe('CacheModule.forRootAsync', () => {
  it('builds the provider from an injected factory', async () => {
    const moduleReference = await Test.createTestingModule({
      imports: [
        CacheModule.forRootAsync({
          imports: [PrefixModule],
          inject: ['PREFIX'],
          useFactory: (prefix: string) => baseOptions({ prefix })
        })
      ]
    }).compile()

    expect(moduleReference.get(HEALTH_CHECK_PROVIDER)).toBe(moduleReference.get(CACHE_PROVIDER))

    await moduleReference.close()
  })

  it('accepts an async factory and honours isGlobal', async () => {
    const definition = CacheModule.forRootAsync({
      isGlobal: true,
      useFactory: () => Promise.resolve(baseOptions())
    })

    expect(definition.global).toBe(true)

    const moduleReference = await Test.createTestingModule({ imports: [definition] }).compile()
    expect(moduleReference.get(CACHE_PROVIDER)).toBeDefined()

    await moduleReference.close()
  })
})
```

E ajuste os dois imports do topo do arquivo para incluir `Module` e `HEALTH_CHECK_PROVIDER`:

```ts
import { Inject, Injectable, Module } from '@nestjs/common'
```

```ts
import { CACHE_PROVIDER, CONTRACT_TOKENS, GET_CACHE_PROVIDER, HEALTH_CHECK_PROVIDER } from '../cache.tokens'
```

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: falha — `forRootAsync` não existe.

- [ ] **Step 2: Implementar (GREEN)**

Em `packages/cache/src/nestjs/cache.module.ts`, logo depois de `forRoot`:

```ts
  public static forRootAsync(options: CacheModuleAsyncOptions): DynamicModule {
    return {
      exports: [CACHE_PROVIDER, ...CONTRACT_TOKENS],
      global: options.isGlobal ?? false,
      imports: options.imports ?? [],
      module: this,
      providers: [
        { provide: CACHE_MODULE_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        buildCacheProvider(),
        ...buildContractAliases()
      ]
    }
  }
```

E o import de tipos passa a trazer também `CacheModuleAsyncOptions`:

```ts
import {
  type CacheModuleAsyncOptions,
  type CacheModuleFactoryOptions,
  type CacheModuleOptions
} from './cache-module.options'
```

- [ ] **Step 3: Verificar**

Run: `pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint && pnpm --filter @ruguin/cache test:unit`
Expected: sem erro; 7 testes do módulo verdes.

- [ ] **Step 4: Commit**

```bash
git add packages/cache/src/nestjs
git commit -m "feat(cache): add CacheModule.forRootAsync for deferred configuration"
```

---

### Task 6: Ciclo de vida da conexão

**Files:**

- Modify: `packages/cache/src/nestjs/cache.module.ts`
- Modify: `packages/cache/src/nestjs/__tests__/cache.module.unit.ts`

**Interfaces:**

- Consumes: `ICacheProvider.connect`, `ICacheProvider.disconnect`.
- Produces: `CacheModule implements OnModuleInit, OnApplicationShutdown`.

Um `connect()` que falha **não** derruba o boot. Isso é a premissa do desenho inteiro: a spec §5.6 define `unhealthy` como "fail-open mantém a aplicação viva, sem cache", e o `ResilientCacheProvider` existe para transformar cache indisponível em miss instantâneo. Se o módulo lançasse aqui, uma queda do Valkey viraria uma queda da API — exatamente o que o breaker foi construído para evitar.

- [ ] **Step 1: Escrever os testes (RED)**

Substitua o fim do `describe('CacheModule.forRoot', ...)` — da última linha do `it` que já existe até o fechamento do `describe` — por:

```ts
    await expect(compiling).rejects.toThrow('InvalidCacheConfigError')
  })

  it('connects on module init and disconnects on shutdown', async () => {
    const moduleReference = await Test.createTestingModule({ imports: [CacheModule.forRoot(baseOptions())] }).compile()

    const cache = moduleReference.get<ICacheProvider>(CACHE_PROVIDER)
    const connect = vi.spyOn(cache, 'connect')
    const disconnect = vi.spyOn(cache, 'disconnect')

    await moduleReference.init()
    expect(connect).toHaveBeenCalledTimes(1)

    await moduleReference.close()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  /*
   * The premise of the whole fail-open design: a cache that cannot be reached degrades the service,
   * it does not stop it. If this ever starts rejecting, a Valkey outage becomes an API outage.
   */
  it('boots even when connect fails', async () => {
    const moduleReference = await Test.createTestingModule({ imports: [CacheModule.forRoot(baseOptions())] }).compile()

    const cache = moduleReference.get<ICacheProvider>(CACHE_PROVIDER)
    vi.spyOn(cache, 'connect').mockResolvedValue(failure(new CacheConnectionError({ operation: 'connect' })))

    await expect(moduleReference.init()).resolves.toBeDefined()

    await moduleReference.close()
  })
})
```

E os imports do topo passam a ser:

```ts
import { Inject, Injectable, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { failure } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import {
  CacheConnectionError,
  CacheConsistency,
  CacheDriver,
  type ICacheProvider,
  type IGetCacheProvider
} from '../../domain'
```

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: `connect` chamado 0 vezes.

- [ ] **Step 2: Implementar (GREEN)**

Em `packages/cache/src/nestjs/cache.module.ts`, a declaração da classe ganha as interfaces, os dois campos e o construtor — é aqui que o campo `cache` passa a ser lido, e por isso é aqui que ele pode existir:

```ts
@Module({})
export class CacheModule implements OnApplicationShutdown, OnModuleInit {
  private readonly cache: ICacheProvider
  private readonly logger = new Logger(LOGGER_CONTEXT)

  constructor(@Inject(CACHE_PROVIDER) cache: ICacheProvider) {
    this.cache = cache
  }
```

Os dois hooks entram depois de `forRootAsync`:

```ts
  /*
   * A dead cache must not be a dead application — that is the premise of the fail-open design
   * (spec §5.6: unhealthy means "the app stays alive, without cache"). A failed connect is therefore
   * reported and the boot continues; the health indicator is what tells the operator about it.
   */
  public async onModuleInit(): Promise<void> {
    const connected = await this.cache.connect()
    if (connected.isFailure()) {
      this.logger.error('cache connect failed on startup; the application will run without cache', connected.value)
    }
  }

  public async onApplicationShutdown(): Promise<void> {
    const disconnected = await this.cache.disconnect()
    if (disconnected.isFailure()) {
      this.logger.warn('cache disconnect failed during shutdown', disconnected.value)
    }
  }
```

E o import de `@nestjs/common` no topo do arquivo passa a ser:

```ts
import {
  type DynamicModule,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
  type Provider
} from '@nestjs/common'
```

- [ ] **Step 3: Verificar**

Run: `pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint && pnpm --filter @ruguin/cache test:unit`
Expected: sem erro; 9 testes do módulo verdes. O `ERROR [CacheModule] cache connect failed on startup` no stderr é o teste de fail-open funcionando.

- [ ] **Step 4: Commit**

```bash
git add packages/cache/src/nestjs
git commit -m "feat(cache): connect on module init and disconnect on application shutdown"
```

---

### Task 7: `CacheHealthIndicator`

**Files:**

- Create: `packages/cache/src/nestjs/cache-health.indicator.ts`
- Create: `packages/cache/src/nestjs/__tests__/cache-health.indicator.unit.ts`
- Modify: `packages/cache/src/nestjs/index.ts`

**Interfaces:**

- Consumes: `IHealthCheckProvider` via `HEALTH_CHECK_PROVIDER`, `HealthCheckProviderDTO.OutputSuccess`, `CacheHealthStatus`.
- Produces: `CacheHealthIndicator.isHealthy(key): Promise<HealthIndicatorResult>`.

Duas restrições fecham o desenho, e nenhuma delas está na spec:

**`@nestjs/terminus` entra só como tipo.** A spec §10.1 diz "estende `HealthIndicator`", mas essa classe está deprecada no Terminus 11, e o lint deste repo tem `sonarjs/deprecation` e `@typescript-eslint/no-deprecated` ligados — estendê-la é erro. O substituto oficial, `HealthIndicatorService`, é pior: seria **injetado**, e o pnpm dá a este pacote uma cópia própria do Terminus, então a classe pedida aqui não é a mesma que o `TerminusModule` provê no app. O Nest recusa (`Nest can't resolve dependencies of the CacheHealthIndicator`). Como o executor do Terminus só lê `status` do objeto devolvido pela função indicadora, montá-lo à mão são três linhas e o acoplamento de runtime desaparece.

**`degraded` conta como up.** Tirar a instância do balanceador porque uma réplica caiu transformaria uma degradação em indisponibilidade — as leituras simplesmente voltam para o master. Só `unhealthy`, que significa master inalcançável, marca down. Os detalhes vão no payload nos dois casos, para o alerta distinguir os cenários.

- [ ] **Step 1: Escrever os testes (RED)**

Crie `packages/cache/src/nestjs/__tests__/cache-health.indicator.unit.ts`:

```ts
import { failure, success } from '@ruguin/utils'
import { describe, expect, it } from 'vitest'

import {
  CacheDriver,
  CacheHealthStatus,
  CacheNotInitializedError,
  type HealthCheckProviderDTO,
  type IHealthCheckProvider
} from '../../domain'
import { CacheHealthIndicator } from '../cache-health.indicator'

const payload = (
  overrides: Partial<HealthCheckProviderDTO.OutputSuccess> = {}
): HealthCheckProviderDTO.OutputSuccess => ({
  checkedAt: new Date('2026-07-31T00:00:00.000Z'),
  clients: { blocked: 0, connected: 3, rejectedTotal: 0 },
  driver: CacheDriver.VALKEY,
  master: { latencyInMs: 2, reachable: true, role: 'master' },
  memory: { evictedKeys: 0, maxBytes: 1000, usedBytes: 100, usedPercentage: 10 },
  replicas: [],
  server: { uptimeInSeconds: 60, version: '7.2.4' },
  status: CacheHealthStatus.HEALTHY,
  ...overrides
})

const indicatorFor = (result: Awaited<HealthCheckProviderDTO.Output>): CacheHealthIndicator => {
  const cache: IHealthCheckProvider = { healthCheck: () => Promise.resolve(result) }

  return new CacheHealthIndicator(cache)
}

describe('CacheHealthIndicator', () => {
  it('reports up when the cache is healthy', async () => {
    const checked = await indicatorFor(success(payload())).isHealthy('cache')

    expect(checked).toMatchObject({ cache: { cacheStatus: CacheHealthStatus.HEALTHY, status: 'up' } })
  })

  /*
   * The rule the whole indicator exists for. A replica that went away means reads fall back to the
   * master; taking the instance out of the load balancer for that turns a degradation into an
   * outage. The detail fields still travel, so an alert can tell degraded from healthy.
   */
  it('reports up when the cache is degraded, with the reason in the payload', async () => {
    const checked = await indicatorFor(
      success(
        payload({
          replicas: [{ host: 'replica:6379', latencyInMs: 3, reachable: false, replicationLagInBytes: null }],
          status: CacheHealthStatus.DEGRADED
        })
      )
    ).isHealthy('cache')

    expect(checked).toMatchObject({
      cache: {
        cacheStatus: CacheHealthStatus.DEGRADED,
        replicas: [{ host: 'replica:6379', reachable: false }],
        status: 'up'
      }
    })
  })

  it('reports down only when the master itself is unreachable', async () => {
    const checked = await indicatorFor(
      success(
        payload({
          master: { error: 'ECONNREFUSED', latencyInMs: 0, reachable: false, role: 'unknown' },
          status: CacheHealthStatus.UNHEALTHY
        })
      )
    ).isHealthy('cache')

    expect(checked).toMatchObject({ cache: { masterReachable: false, status: 'down' } })
  })

  /* A check that never ran is not a healthy cache — the only Either failure the contract admits. */
  it('reports down when the health check itself could not run', async () => {
    const checked = await indicatorFor(failure(new CacheNotInitializedError({ operation: 'healthCheck' }))).isHealthy(
      'cache'
    )

    expect(checked).toMatchObject({ cache: { status: 'down' } })
    expect(checked.cache).toHaveProperty('error')
  })

  it('carries the pressure signals an alert needs', async () => {
    const checked = await indicatorFor(
      success(
        payload({
          clients: { blocked: 0, connected: 90, rejectedTotal: 12 },
          memory: { evictedKeys: 5000, maxBytes: 1000, usedBytes: 950, usedPercentage: 95 },
          status: CacheHealthStatus.DEGRADED
        })
      )
    ).isHealthy('cache')

    expect(checked).toMatchObject({
      cache: { clientsRejectedTotal: 12, evictedKeys: 5000, memoryUsedPercentage: 95 }
    })
  })
})
```

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: falha por não encontrar `../cache-health.indicator`.

- [ ] **Step 2: Implementar (GREEN)**

Crie `packages/cache/src/nestjs/cache-health.indicator.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'
import { type HealthIndicatorResult } from '@nestjs/terminus'

import { CacheHealthStatus, type HealthCheckProviderDTO, type IHealthCheckProvider } from '../domain'

import { HEALTH_CHECK_PROVIDER } from './cache.tokens'

/*
 * Flattened deliberately: Terminus renders whatever object it is handed straight into the /health
 * payload, and a nested master/replicas/memory tree there is a body an alert rule has to walk. The
 * fields kept are the ones spec §5.6 argues catch trouble before it becomes an incident.
 *
 * `cacheStatus`, not `status`: Terminus owns the `status` key of every indicator entry.
 */
const toDetails = (payload: HealthCheckProviderDTO.OutputSuccess) => ({
  cacheStatus: payload.status,
  clientsConnected: payload.clients.connected,
  clientsRejectedTotal: payload.clients.rejectedTotal,
  driver: payload.driver,
  evictedKeys: payload.memory.evictedKeys,
  masterLatencyInMs: payload.master.latencyInMs,
  masterReachable: payload.master.reachable,
  memoryUsedPercentage: payload.memory.usedPercentage,
  replicas: payload.replicas.map((replica) => ({
    host: replica.host,
    reachable: replica.reachable,
    replicationLagInBytes: replica.replicationLagInBytes
  })),
  serverVersion: payload.server.version
})

/*
 * @nestjs/terminus is imported for types only, and nothing from it is injected. That is not
 * fastidiousness: pnpm gives this package its own copy of terminus, so a HealthIndicatorService
 * asked for here would be a different class from the one TerminusModule provides in the app, and
 * Nest would refuse to resolve it. Terminus reads `status` off whatever object the indicator
 * function returns, and that object is three lines to build.
 *
 * The app declares this provider in the module that imports TerminusModule; CacheModule does not
 * register it, so a consumer with no HTTP surface never pulls terminus in at all.
 */
@Injectable()
export class CacheHealthIndicator {
  private readonly cache: IHealthCheckProvider

  constructor(@Inject(HEALTH_CHECK_PROVIDER) cache: IHealthCheckProvider) {
    this.cache = cache
  }

  /*
   * `degraded` counts as up. Pulling the instance out of the load balancer because one replica went
   * away would turn a degradation into an outage — reads simply fall back to the master and the
   * application keeps serving. Only `unhealthy`, meaning the master itself is unreachable, marks
   * down. The collected details ride along in both cases, which is what lets an alert tell the two
   * scenarios apart.
   */
  public async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const checked = await this.cache.healthCheck()

    if (checked.isFailure()) return { [key]: { error: checked.value.message, status: 'down' } }

    const isUp: boolean = checked.value.status !== CacheHealthStatus.UNHEALTHY

    return { [key]: { ...toDetails(checked.value), status: isUp ? 'up' : 'down' } }
  }
}
```

- [ ] **Step 3: Atualizar o barrel**

`packages/cache/src/nestjs/index.ts`:

```ts
export * from './cache.module'
export * from './cache.tokens'
export * from './cache-health.indicator'
export * from './cache-module.options'
export * from './inject-cache.decorator'
```

- [ ] **Step 4: Verificar**

Run: `pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint && pnpm --filter @ruguin/cache test:all`
Expected: sem erro; 259 testes verdes.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src/nestjs
git commit -m "feat(cache): add a terminus health indicator that treats degraded as up"
```

---

### Task 8: Export `@ruguin/env/cache` e a costura no `core-server`

**Files:**

- Modify: `packages/env/package.json`
- Modify: `apps/core-server/package.json`
- Create: `apps/core-server/src/cache/cache-module-options.ts`
- Create: `apps/core-server/src/cache/__tests__/cache-module-options.unit.ts`

**Interfaces:**

- Consumes: `cacheENV` de `@ruguin/env/cache`.
- Produces: `createCacheModuleOptions(environment): CacheModuleFactoryOptions`.

O `@ruguin/env` já ganhou `./docs` pelo mesmo motivo que agora ganha `./cache`: o barrel avalia todo schema irmão no import, e o `core-server` passaria a exigir as variáveis de banco, message broker e token provider que ele não usa.

A costura mora no app, não no pacote. Puxar `@ruguin/env` para dentro de `@ruguin/cache` decidiria, por todo consumidor futuro, que a configuração do cache vem de variáveis de ambiente — e o primeiro worker que ler config de outro lugar teria que conviver com um schema validado que não usa.

- [ ] **Step 1: Declarar o export path do env**

Em `packages/env/package.json`, o bloco `exports` (ordem alfabética):

```json
  "exports": {
    ".": "./src/index.ts",
    "./cache": "./src/packages/cache.environment.ts",
    "./docs": "./src/packages/docs.environment.ts"
  },
```

- [ ] **Step 2: Declarar a dependência no `core-server`**

Em `apps/core-server/package.json`, em `dependencies` (ordem alfabética, logo antes de `@ruguin/env`):

```json
    "@ruguin/cache": "workspace:*",
```

- [ ] **Step 3: Instalar**

Run: `pnpm install`
Expected: sucesso, incluindo o `postinstall` que roda `turbo run build`.

- [ ] **Step 4: Escrever o teste da costura (RED)**

Crie `apps/core-server/src/cache/__tests__/cache-module-options.unit.ts`:

```ts
import { type cacheENV } from '@ruguin/env/cache'
import { describe, expect, it } from 'vitest'

import { createCacheModuleOptions } from '../cache-module-options'

const environmentWith = (overrides: Partial<typeof cacheENV> = {}): typeof cacheENV => ({
  CACHE_BREAKER_FAILURE_THRESHOLD: 5,
  CACHE_BREAKER_RESET_TIMEOUT_MS: 10_000,
  CACHE_DEFAULT_CONSISTENCY: 'eventual',
  CACHE_DEFAULT_TTL_MS: 300_000,
  CACHE_DRIVER: 'memory',
  CACHE_INVALIDATION_BROADCAST: true,
  CACHE_JITTER_RATIO: 0.1,
  CACHE_MASTER_URL: undefined,
  CACHE_NEGATIVE_TTL_MS: 30_000,
  CACHE_NS_VERSION_LOCAL_TTL_MS: 5000,
  CACHE_OPERATION_TIMEOUT_MS: 500,
  CACHE_PREFIX: 'ruguin:test',
  CACHE_REPLICA_URLS: [],
  CACHE_REPLICATION_LAG_THRESHOLD_BYTES: 1_048_576,
  ...overrides
})

describe('createCacheModuleOptions', () => {
  it('carries every validated setting through to the factory config', () => {
    const options = createCacheModuleOptions(environmentWith())

    expect(options).toMatchObject({
      breaker: { failureThreshold: 5, resetTimeoutInMs: 10_000 },
      defaultConsistency: 'eventual',
      defaultTtlInMs: 300_000,
      driver: 'memory',
      invalidationBroadcast: true,
      jitterRatio: 0.1,
      negativeTtlInMs: 30_000,
      prefix: 'ruguin:test'
    })
  })

  it('derives the lock TTL from the operation timeout', () => {
    expect(createCacheModuleOptions(environmentWith({ CACHE_OPERATION_TIMEOUT_MS: 250 })).lockTtlInMs).toBe(2500)
  })

  /*
   * Absent, not present-and-undefined. This app compiles with exactOptionalPropertyTypes, and the
   * factory's `masterUrl?: string` would reject an explicit undefined.
   */
  it('omits masterUrl and replicaUrls entirely when the environment has none', () => {
    const options = createCacheModuleOptions(environmentWith())

    expect(options).not.toHaveProperty('masterUrl')
    expect(options).not.toHaveProperty('replicaUrls')
  })

  it('passes the valkey endpoints through when they are configured', () => {
    const options = createCacheModuleOptions(
      environmentWith({
        CACHE_DRIVER: 'valkey',
        CACHE_MASTER_URL: 'redis://localhost:6379',
        CACHE_REPLICA_URLS: ['redis://localhost:6380']
      })
    )

    expect(options).toMatchObject({
      driver: 'valkey',
      masterUrl: 'redis://localhost:6379',
      replicaUrls: ['redis://localhost:6380']
    })
  })
})
```

Run: `pnpm --filter @ruguin/core-server test`
Expected: falha por não encontrar `../cache-module-options`.

- [ ] **Step 5: Implementar (GREEN)**

Crie `apps/core-server/src/cache/cache-module-options.ts`:

```ts
import { type CacheModuleFactoryOptions } from '@ruguin/cache/nestjs'
import { type cacheENV } from '@ruguin/env/cache'

/*
 * The seam between the validated environment and the framework-agnostic package. It lives in the
 * app, not in @ruguin/cache: the package must stay usable by a worker that gets its configuration
 * from somewhere else entirely, and pulling @ruguin/env into it would decide that question for
 * every future consumer.
 *
 * Takes the environment as an argument, in the same shape as createPinoHttpOptions, so a test can
 * hand it a fabricated one instead of mutating process.env.
 */
export function createCacheModuleOptions(environment: typeof cacheENV): CacheModuleFactoryOptions {
  return {
    breaker: {
      failureThreshold: environment.CACHE_BREAKER_FAILURE_THRESHOLD,
      resetTimeoutInMs: environment.CACHE_BREAKER_RESET_TIMEOUT_MS
    },
    defaultConsistency: environment.CACHE_DEFAULT_CONSISTENCY,
    defaultTtlInMs: environment.CACHE_DEFAULT_TTL_MS,
    driver: environment.CACHE_DRIVER,
    invalidationBroadcast: environment.CACHE_INVALIDATION_BROADCAST,
    jitterRatio: environment.CACHE_JITTER_RATIO,
    /*
     * Not an environment variable of its own: the lock TTL is an upper bound on how long a stampede
     * winner may hold the key, and the operation timeout is what the losers wait through. Ten times
     * the timeout leaves room for a slow loader without letting a crashed holder block the namespace
     * for a noticeable stretch.
     */
    lockTtlInMs: environment.CACHE_OPERATION_TIMEOUT_MS * 10,
    namespaceVersionLocalTtlInMs: environment.CACHE_NS_VERSION_LOCAL_TTL_MS,
    negativeTtlInMs: environment.CACHE_NEGATIVE_TTL_MS,
    operationTimeoutInMs: environment.CACHE_OPERATION_TIMEOUT_MS,
    prefix: environment.CACHE_PREFIX,
    replicationLagThresholdInBytes: environment.CACHE_REPLICATION_LAG_THRESHOLD_BYTES,
    /*
     * Conditional spread rather than `masterUrl: environment.CACHE_MASTER_URL`: this app compiles
     * with exactOptionalPropertyTypes, under which an optional property will not accept an explicit
     * undefined.
     */
    ...(environment.CACHE_MASTER_URL !== undefined && { masterUrl: environment.CACHE_MASTER_URL }),
    ...(environment.CACHE_REPLICA_URLS.length > 0 && { replicaUrls: environment.CACHE_REPLICA_URLS })
  }
}
```

- [ ] **Step 6: Verificar**

Run: `pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/core-server check:lint && pnpm --filter @ruguin/core-server test`
Expected: sem erro; 4 testes novos verdes.

- [ ] **Step 7: Commit**

```bash
git add packages/env/package.json apps/core-server/package.json apps/core-server/src/cache pnpm-lock.yaml
git commit -m "feat(core-server): map the validated cache environment onto the factory config"
```

---

### Task 9: Registrar o `CacheModule` no `AppModule`

**Files:**

- Modify: `apps/core-server/src/app.module.ts`
- Modify: `apps/core-server/src/bootstrap/__tests__/configure-app.e2e.ts`
- Modify: `apps/core-server/src/bootstrap/__tests__/configure-app.live.e2e.ts`
- Modify: `apps/core-server/src/health/__tests__/health.controller.e2e.ts`

**Interfaces:**

- Consumes: `CacheModule.forRoot`, `createCacheModuleOptions`, `cacheENV`.
- Produces: `CACHE_PROVIDER` e os 24 aliases disponíveis em qualquer módulo da aplicação.

O registro é `isGlobal: true`. Cache é infraestrutura que qualquer módulo de feature pode querer, e obrigar cada um a importar `CacheModule` só acrescenta cerimônia — quem decide quanto da superfície um construtor enxerga continua sendo o token escolhido no ponto de injeção, não o import do módulo.

A partir daqui `AppModule` importa `@ruguin/env/cache`, que valida o schema **no import**. Todo e2e que monta o `AppModule` precisa das variáveis antes do grafo de módulos existir — é o que o `vi.hoisted` compra.

- [ ] **Step 1: Registrar o módulo**

Substitua `apps/core-server/src/app.module.ts` inteiro:

```ts
import { Module } from '@nestjs/common'
import { CacheModule } from '@ruguin/cache/nestjs'
import { cacheENV } from '@ruguin/env/cache'
import { LoggerModule } from 'nestjs-pino'

import { createCacheModuleOptions } from './cache/cache-module-options'
import { HealthModule } from './health/health.module'
import { createPinoHttpOptions } from './logger/pino-http-options'

@Module({
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => ({ pinoHttp: createPinoHttpOptions(process.env) })
    }),
    /*
     * Global: the cache is infrastructure every feature module may reach for, and making each one
     * import CacheModule would only add ceremony — the tokens are still what decides how much of the
     * surface a given constructor sees.
     */
    CacheModule.forRoot({ isGlobal: true, ...createCacheModuleOptions(cacheENV) }),
    HealthModule
  ],
  controllers: [],
  providers: []
})
export class AppModule {}
```

- [ ] **Step 2: Confirmar que os e2e quebram, e por quê**

Run: `pnpm --filter @ruguin/core-server test:e2e`
Expected: as três suítes falham com `Error: Invalid environment variables` apontando `CACHE_PREFIX`. É o schema do `@ruguin/env` fazendo o que deve — quebrar no boot, não no meio de uma request.

- [ ] **Step 3: Dar o ambiente aos dois e2e de bootstrap**

Em `apps/core-server/src/bootstrap/__tests__/configure-app.e2e.ts` **e** em `configure-app.live.e2e.ts`, substitua o bloco `vi.hoisted` existente por:

```ts
/*
 * AppModule now registers CacheModule, and @ruguin/env validates the cache schema at import time —
 * so these have to be in place before the module graph is built, which is what vi.hoisted buys.
 * The memory driver keeps this suite free of Docker; the Valkey-backed behaviour has its own suite.
 */
vi.hoisted(() => {
  process.env.DOCS_USERNAME = 'test-docs-user'
  process.env.DOCS_PASSWORD = 'test-docs-pass'
  process.env.CACHE_PREFIX = 'ruguin:e2e'
  process.env.CACHE_DRIVER = 'memory'
})
```

- [ ] **Step 4: Dar o ambiente ao e2e do health**

Em `apps/core-server/src/health/__tests__/health.controller.e2e.ts`, acrescente `vi` ao import do vitest e o bloco logo depois do import do `AppModule`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../app.module'

/* @ruguin/env validates the cache schema at import time; vi.hoisted runs before the module graph. */
vi.hoisted(() => {
  process.env.CACHE_PREFIX = 'ruguin:e2e'
  process.env.CACHE_DRIVER = 'memory'
})
```

- [ ] **Step 5: Verificar**

Run: `pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/core-server check:lint && pnpm --filter @ruguin/core-server test:all`
Expected: sem erro; as três suítes e2e verdes de novo.

- [ ] **Step 6: Commit**

```bash
git add apps/core-server/src
git commit -m "feat(core-server): register the cache module globally"
```

---

### Task 10: Ligar o indicator no `/health`

**Files:**

- Modify: `apps/core-server/src/health/health.module.ts`
- Modify: `apps/core-server/src/health/health.controller.ts`
- Modify: `apps/core-server/src/health/__tests__/health.controller.e2e.ts`

**Interfaces:**

- Consumes: `CacheHealthIndicator`, `HEALTH_CHECK_PROVIDER` (via `CacheModule` global).
- Produces: `GET /health` com um indicador `cache` no `details` e no `info`/`error`.

`this.health.check([])` responde `ok` sobre coisa nenhuma — uma resposta sem conteúdo informativo, que passa exatamente igual com o Valkey no ar e com ele derrubado.

O `CacheHealthIndicator` é declarado aqui, e não pelo `CacheModule`, porque registrá-lo lá empurraria `@nestjs/terminus` para todo consumidor do cache. O token de cache que ele injeta vem do `CacheModule` global da Task 9.

- [ ] **Step 1: Escrever a expectativa (RED)**

Em `apps/core-server/src/health/__tests__/health.controller.e2e.ts`, substitua o fim do arquivo — da última linha do `it` que já existe até o fechamento do `describe` — por:

```ts
    expect(response.body).toMatchObject({ status: 'ok' })
  })

  /* The endpoint used to answer `ok` with an empty indicator list — an answer about nothing. */
  it('reports the cache as an indicator rather than an empty check list', async () => {
    const response = await request(app.getHttpServer() as Parameters<typeof request>[0]).get('/health')

    expect(response.body).toMatchObject({
      details: { cache: { cacheStatus: 'healthy', driver: 'memory', status: 'up' } },
      info: { cache: { status: 'up' } }
    })
  })
})
```

Run: `pnpm --filter @ruguin/core-server test:e2e`
Expected: falha — `details` vem vazio.

- [ ] **Step 2: Declarar o provider**

Substitua `apps/core-server/src/health/health.module.ts` inteiro:

```ts
import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { CacheHealthIndicator } from '@ruguin/cache/nestjs'

import { HealthController } from './health.controller'

/*
 * CacheHealthIndicator is declared here rather than by CacheModule: registering it there would push
 * @nestjs/terminus onto every consumer of the cache, including the ones with no HTTP surface at all.
 * The cache token it injects comes from the globally registered CacheModule.
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [CacheHealthIndicator]
})
export class HealthModule {}
```

- [ ] **Step 3: Ligar no controller (GREEN)**

Substitua `apps/core-server/src/health/health.controller.ts` inteiro:

```ts
import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common'
import { HealthCheck, type HealthCheckResult, HealthCheckService } from '@nestjs/terminus'
import { CacheHealthIndicator } from '@ruguin/cache/nestjs'

@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly cacheHealth: CacheHealthIndicator
  ) {}

  /*
   * The return type is spelled out rather than inferred. @ruguin/cache carries @nestjs/terminus as
   * an optional peer plus a devDependency of its own, so pnpm gives it a second copy of the types
   * and the inferred signature would name a path under packages/cache/node_modules — TS2742, and a
   * declaration nobody outside this workspace layout could consume.
   */
  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([() => this.cacheHealth.isHealthy('cache')])
  }
}
```

A anotação `: Promise<HealthCheckResult>` não é estilo. Sem ela o `nest build` falha com `TS2742: The inferred type of 'check' cannot be named without a reference to '../../../../packages/cache/node_modules/@nestjs/terminus/dist'` — e esse erro só aparece depois de um `pnpm install` de verdade, não no `tsc --noEmit` de um checkout com node_modules antigo.

`VERSION_NEUTRAL` fica como está: veio do trabalho de API docs, e `/health` não deve ganhar prefixo de versão.

- [ ] **Step 4: Verificar**

Run: `pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/core-server check:lint && pnpm --filter @ruguin/core-server test:all && pnpm --filter @ruguin/core-server build`
Expected: sem erro; e2e verdes; `TSC Found 0 issues`.

- [ ] **Step 5: Commit**

```bash
git add apps/core-server/src/health
git commit -m "feat(core-server): report cache health from the health endpoint"
```

---

### Task 11: e2e contra o Valkey real, e contra um Valkey ausente

**Files:**

- Create: `apps/core-server/src/health/__tests__/health.controller.valkey.e2e.ts`
- Create: `apps/core-server/src/health/__tests__/health.controller.cache-down.e2e.ts`

**Interfaces:**

- Consumes: `AppModule`, Valkey em `localhost:6379` com réplica em `localhost:6380`.
- Produces: prova de que `/health` reporta o estado real do servidor, nos dois extremos.

Cada suíte é um arquivo separado, e não outro `describe`: o `@ruguin/env` valida e congela o schema do cache na primeira vez que `cache.environment.ts` é importado, então um grafo de módulos tem exatamente um driver. O Vitest isola arquivos em workers distintos, e é isso que permite a esta suíte e à da Task 9 discordarem sobre `CACHE_DRIVER`.

- [ ] **Step 1: Garantir a infraestrutura local**

```bash
docker compose -f infrastructure/local/docker-compose.yml up -d redis redis-replica
docker exec ruguin-redis-replica-1 valkey-cli info replication | head -5
```

Expected: `role:slave` e `master_link_status:up`. Se aparecer `down`, espere alguns segundos e repita — o primeiro sync leva um instante.

- [ ] **Step 2: e2e contra o Valkey no ar**

Crie `apps/core-server/src/health/__tests__/health.controller.valkey.e2e.ts`:

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify'

import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../app.module'

/*
 * Its own file, not another describe block: @ruguin/env validates and freezes the cache schema the
 * first time cache.environment.ts is imported, so one module graph gets exactly one driver. Vitest
 * isolates files into separate workers, which is what lets this suite and the memory-backed one
 * disagree about CACHE_DRIVER.
 *
 * Requires the local stack:
 * docker compose -f infrastructure/local/docker-compose.yml up -d redis redis-replica
 */
vi.hoisted(() => {
  process.env.CACHE_PREFIX = 'ruguin:e2e-valkey'
  process.env.CACHE_DRIVER = 'valkey'
  process.env.CACHE_MASTER_URL = 'redis://localhost:6379'
  process.env.CACHE_REPLICA_URLS = 'redis://localhost:6380'
})

type CacheDetails = Readonly<{
  clientsRejectedTotal: number
  driver: string
  evictedKeys: number
  masterLatencyInMs: number
  masterReachable: boolean
  replicas: readonly unknown[]
  serverVersion: string
  status: string
}>

const context: { app: NestFastifyApplication | null } = { app: null }

const cacheDetails = async (): Promise<CacheDetails> => {
  const response = await context.app!.inject({ method: 'GET', url: '/health' })
  const body = JSON.parse(response.body) as { details: { cache: CacheDetails } }

  return body.details.cache
}

describe('GET /health against a live Valkey', () => {
  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()
    const app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    context.app = app
  })

  afterAll(async () => {
    await context.app?.close()
  })

  it('answers 200 and reports the master it actually reached', async () => {
    const response = await context.app!.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      details: { cache: { driver: 'valkey', masterReachable: true, status: 'up' } },
      status: 'ok'
    })
  })

  /*
   * The numbers spec §5.6 argues catch trouble before it becomes an incident. Asserting they are
   * present and numeric is the point — the values belong to whatever the server happens to be doing.
   */
  it('carries the server-reported pressure signals', async () => {
    const details = await cacheDetails()

    expect(details.serverVersion).toEqual(expect.any(String))
    expect(details.evictedKeys).toEqual(expect.any(Number))
    expect(details.clientsRejectedTotal).toEqual(expect.any(Number))
    expect(details.masterLatencyInMs).toEqual(expect.any(Number))
  })

  it('reports the configured replica', async () => {
    const details = await cacheDetails()

    expect(details.replicas).toHaveLength(1)
  })
})
```

O objeto `context` em vez de um `let` de módulo é exigência do `unicorn/no-top-level-assignment-in-function`.

- [ ] **Step 3: e2e com o Valkey ausente**

Crie `apps/core-server/src/health/__tests__/health.controller.cache-down.e2e.ts`:

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify'

import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../app.module'

/*
 * Port 6399 has nothing behind it. No Docker needed: the point is what the application does when
 * the cache is gone, and a refused connection is the cheapest way to be sure it is.
 */
vi.hoisted(() => {
  process.env.CACHE_PREFIX = 'ruguin:e2e-down'
  process.env.CACHE_DRIVER = 'valkey'
  process.env.CACHE_MASTER_URL = 'redis://localhost:6399'
  process.env.CACHE_REPLICA_URLS = ''
})

describe('GET /health when the cache is unreachable', () => {
  const context: { app: NestFastifyApplication | null } = { app: null }

  /*
   * That this beforeAll finishes at all is half the assertion: CacheModule.onModuleInit reports a
   * failed connect and lets the boot continue, because a Valkey outage must not be an API outage.
   */
  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()
    const app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    context.app = app
  })

  afterAll(async () => {
    await context.app?.close()
  })

  it('answers 503 and names the cache as the indicator that is down', async () => {
    const response = await context.app!.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toMatchObject({ error: { cache: { status: 'down' } }, status: 'error' })
  })
})
```

O `[ioredis] Unhandled error event: connect ECONNREFUSED` e o `ERROR [CacheModule] cache connect failed on startup` no stderr são o comportamento sob teste, não ruído.

- [ ] **Step 4: Verificar**

Run: `pnpm --filter @ruguin/core-server check:types && pnpm --filter @ruguin/core-server check:lint && pnpm --filter @ruguin/core-server test:e2e`
Expected: sem erro; 5 arquivos e2e, todos verdes.

- [ ] **Step 5: Commit**

```bash
git add apps/core-server/src/health/__tests__
git commit -m "test(core-server): cover the health endpoint against a live and an absent valkey"
```

---

### Task 12: Encerramento limpo e documentação

**Files:**

- Modify: `apps/core-server/src/main.ts`
- Modify: `packages/cache/CLAUDE.md`
- Modify: `apps/core-server/README.md`

**Interfaces:**

- Consumes: `onApplicationShutdown` do `CacheModule`.
- Produces: `disconnect()` executado em SIGTERM.

`onApplicationShutdown` só roda para um `app.close()` explícito — que é o que os testes fazem — a menos que os hooks de sinal estejam ligados. Em produção o processo morreria com os sockets do Valkey abertos, e o servidor veria o cliente sumir em vez de sair.

- [ ] **Step 1: Ligar os shutdown hooks**

Substitua `apps/core-server/src/main.ts` inteiro:

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
/*
 * Without this, onApplicationShutdown only runs for an explicit app.close(); a SIGTERM from the
 * orchestrator would kill the process with the Valkey sockets still open, and the server would see
 * the client disappear rather than quit.
 */
app.enableShutdownHooks()
await configureApp(app)
await app.listen(process.env.PORT ?? 3000, '0.0.0.0')
```

- [ ] **Step 2: Documentar o export no `CLAUDE.md` do pacote**

`packages/cache/CLAUDE.md` está no `.prettierignore`, então o alinhamento aqui é o que você escrever. Na árvore de `## Structure`, logo abaixo da linha de `cache.factory.ts`:

```text
  nestjs/         # optional adapter behind the ./nestjs export: CacheModule, tokens, health indicator
```

E troque a última linha do bloco, `index.ts        # barrel: application, domain, infra`, por:

```text
  index.ts        # barrel: application, domain, infra — the framework-agnostic surface
```

Em `## Rules`, acrescente ao fim:

```markdown
- O adapter NestJS mora atrás do export `./nestjs`, com `@nestjs/common` e `@nestjs/terminus` como
  peers **opcionais**: o barrel raiz continua consumível por um worker sem NestJS. Nada do Terminus
  é injetado dentro do pacote — o pnpm dá a ele uma cópia própria, e uma classe injetada de lá não
  seria a mesma que o `TerminusModule` provê no app.
- Os 24 tokens granulares e o `CACHE_PROVIDER` resolvem todos para a **mesma** instância
  (`useExisting`). O token escolhido no ponto de injeção decide quanto da superfície o construtor
  enxerga, não quantos objetos existem.
- `connect()` que falha no boot é reportado e o boot continua: fail-open significa que uma queda do
  Valkey degrada o serviço, não o derruba. Config inválida, ao contrário, lança — é erro de boot.
- O pacote compila com `exactOptionalPropertyTypes`, porque o `core-server` compila estes fontes com
  essa opção ligada. Campo opcional recebe spread condicional, nunca `undefined` explícito.
```

Em `## Commands`, acrescente:

```bash
pnpm --filter @ruguin/core-server test:e2e   # inclui /health contra o Valkey real
```

- [ ] **Step 3: Documentar as variáveis no README do `core-server`**

Ao contrário do `CLAUDE.md`, este arquivo **não** está no `.prettierignore`: acrescente as linhas sem se preocupar com alinhamento e deixe o `prettier --write` realinhar a tabela inteira. Depois da linha de `NODE_ENV`:

```markdown
| `CACHE_PREFIX` | yes | Prefix of every physical cache key. No default — the app does not boot without it. |
| `CACHE_DRIVER` | no (default `memory`) | `valkey`, `memory` or `noop`. |
| `CACHE_MASTER_URL` | conditional | Required when `CACHE_DRIVER=valkey`. |
| `CACHE_REPLICA_URLS` | no (default empty) | Comma-separated; eventual reads round-robin across them. |
| `CACHE_DEFAULT_TTL_MS` | no (default `300000`) | TTL applied when the call site declares none. |
| `CACHE_JITTER_RATIO` | no (default `0.1`) | Spread applied to the TTL, against a mass expiry. |
| `CACHE_NEGATIVE_TTL_MS` | no (default `30000`) | TTL of `getOrSet`'s negative cache. |
| `CACHE_NS_VERSION_LOCAL_TTL_MS` | no (default `5000`) | Ceiling on how long an invalidation may not have reached this instance. |
| `CACHE_DEFAULT_CONSISTENCY` | no (default `eventual`) | `eventual` or `strong`. |
| `CACHE_INVALIDATION_BROADCAST` | no (default `true`) | Pub/Sub that shortens the invalidation window. |
| `CACHE_OPERATION_TIMEOUT_MS` | no (default `500`) | Deadline of one command; the lock TTL is ten times this. |
| `CACHE_BREAKER_FAILURE_THRESHOLD` | no (default `5`) | Consecutive failures that open the circuit. |
| `CACHE_BREAKER_RESET_TIMEOUT_MS` | no (default `10000`) | Wait before the circuit tries again. |
| `CACHE_REPLICATION_LAG_THRESHOLD_BYTES` | no (default `1048576`) | Lag above which health reports `degraded`. |
```

E o parágrafo logo abaixo da tabela passa a ser (o texto do arquivo está em inglês; mantenha):

```markdown
These are the only variables the app reads. `configure-app.ts` imports `@ruguin/env/docs` and `app.module.ts`
imports `@ruguin/env/cache`, rather than the `@ruguin/env` barrel: the barrel evaluates every sibling schema at
import time, which would make `core-server` require the database, message-broker and token-provider variables it
does not use.
```

Run: `npx prettier --write apps/core-server/README.md`
Expected: a tabela inteira realinhada; `npx prettier --check apps/core-server/README.md` passa.

- [ ] **Step 4: Verificar tudo**

```bash
pnpm turbo run check:types check:lint test:all
pnpm turbo run build
```

Expected: 19 tarefas de verificação e 4 de build, todas com sucesso.

- [ ] **Step 5: Commit**

```bash
git add apps/core-server/src/main.ts apps/core-server/README.md packages/cache/CLAUDE.md
git commit -m "feat(core-server): enable shutdown hooks so the cache disconnects on SIGTERM"
```

---

## Verificação final

- [ ] `pnpm --filter @ruguin/cache check:types` — sem erro, já com `exactOptionalPropertyTypes`.
- [ ] `pnpm --filter @ruguin/cache check:lint` — sem erro e sem warning.
- [ ] `pnpm --filter @ruguin/cache test:all` — 259 testes verdes em 32 arquivos (integração exige `redis` e `redis-replica` no ar).
- [ ] `pnpm --filter @ruguin/core-server check:types` — sem erro.
- [ ] `pnpm --filter @ruguin/core-server check:lint` — sem erro e sem warning.
- [ ] `pnpm --filter @ruguin/core-server test:all` — 40 testes verdes em 9 arquivos.
- [ ] `pnpm --filter @ruguin/core-server build` — `TSC Found 0 issues`, sem `TS2742`.
- [ ] `pnpm turbo run check:types check:lint test:all` — 19 tarefas, todas com sucesso.
- [ ] `docker compose -f infrastructure/local/docker-compose.yml stop redis` e então `pnpm --filter @ruguin/core-server test:e2e src/health/__tests__/health.controller.cache-down.e2e.ts` — 503 com `error.cache.status === 'down'`, e a aplicação sobe do mesmo jeito. Não esqueça de subir o `redis` de volta.

## Decisões tomadas neste plano que a spec não cobre

| Decisão                                                           | Motivo                                                                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ruguin/cache` passa a compilar com `exactOptionalPropertyTypes` | O pacote não tem build, então o `core-server` compila estes fontes com as opções dele; sem isso, nove `TS2379` nascem aqui e aparecem lá        |
| `HealthIndicator` do Terminus **não** é estendido (contra §10.1)  | Está deprecado no Terminus 11 e o repo tem `sonarjs/deprecation` e `no-deprecated` ligados — estender é erro de lint                            |
| `HealthIndicatorService` também não é injetado                    | O pnpm dá ao pacote uma cópia própria do Terminus; a classe pedida ali não é a que o `TerminusModule` provê, e o Nest recusa resolver           |
| O indicator monta o `HealthIndicatorResult` à mão                 | Consequência das duas linhas acima; o executor do Terminus só lê `status`, e o objeto são três linhas                                           |
| `CacheHealthIndicator` não é registrado pelo `CacheModule`        | Registrá-lo lá empurraria `@nestjs/terminus` para todo consumidor, inclusive workers sem superfície HTTP                                        |
| `forRoot` exige a config inteira, não só `{ isGlobal: true }`     | `CacheFactoryDTO.Config` não tem defaults para `prefix`/TTLs, e um cache com prefixo escolhido por omissão é irrastreável a partir do call site |
| `onCacheError` é o único campo opcional, com default de `Logger`  | Reportar falha engolida é competência de adapter de framework; o núcleo agnóstico não tem logger                                                |
| A factory de DI lança em vez de propagar `Either`                 | O Nest não tem outro canal de falha, e um container que entrega cache pela metade é pior que um que se recusa a subir                           |
| O erro de domínio viaja em `cause` de um `Error`                  | `BaseError` não estende `Error`; `@typescript-eslint/only-throw-error` recusa lançá-lo direto                                                   |
| `connect()` que falha não derruba o boot                          | Fail-open é a premissa do pacote inteiro (spec §5.6); lançar aqui transformaria queda do Valkey em queda da API                                 |
| `lockTtlInMs` derivado de `CACHE_OPERATION_TIMEOUT_MS * 10`       | Não existe variável para ele; dez vezes o timeout dá folga para um loader lento sem deixar um holder morto bloquear o namespace                 |
| `createCacheModuleOptions` mora no app, não no pacote             | Puxar `@ruguin/env` para `@ruguin/cache` decidiria, por todo consumidor futuro, que a config vem de variáveis de ambiente                       |
| `@ruguin/env` ganha o export `./cache`                            | Mesmo motivo de `./docs`: o barrel avalia todo schema irmão e faria o `core-server` exigir variáveis que não usa                                |
| `HealthController.check()` com tipo de retorno explícito          | Sem ele, o `nest build` falha com `TS2742` apontando um caminho dentro de `packages/cache/node_modules`                                         |
| e2e do Valkey e e2e do cache ausente em arquivos separados        | `cacheENV` é validado uma vez por grafo de módulos; só a isolação por arquivo do Vitest permite dois drivers                                    |
| `enableShutdownHooks()` no `main.ts`                              | Sem ele o `disconnect()` só roda num `app.close()` explícito, e o processo morreria em SIGTERM com os sockets abertos                           |
| `packages/cache/vitest.config.ts` fica como está                  | Verificado com uma sonda `Reflect.getMetadata`: o transform oxc do Vite já emite `design:paramtypes`; SWC seria duas devDeps sem função         |
