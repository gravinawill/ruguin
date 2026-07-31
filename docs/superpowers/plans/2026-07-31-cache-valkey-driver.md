# `@ruguin/cache` — Driver Valkey (Plano 2 de 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar o driver `valkey` de ponta a ponta — conexoes master/replica/subscriber, operations por concern, scripts Lua, broadcast de invalidacao por Pub/Sub, os dois Decorators e a `CacheFactory` — mais os testes de integracao contra um Valkey real.

**Architecture:** Clean Architecture em tres camadas, ja estabelecida pelo plano 1. `domain/` so tem tipos, enums e erros. `application/` orquestra contratos. `infra/` traz as implementacoes. Este plano preenche `infra/drivers/valkey/`, `infra/decorators/` e `factory/`, sem tocar em `domain/contracts/`.

**Tech Stack:** TypeScript 6.0.3, Vitest 4, `iovalkey` 0.4.0, `@opentelemetry/api` 1.9, pnpm workspaces, Turbo. Valkey 9.1.1 local (reporta `redis_version:7.2.4` por compatibilidade de protocolo).

**Spec:** `docs/superpowers/specs/2026-07-31-cache-package-design.md`

**Depende de:** `docs/superpowers/plans/2026-07-31-cache-package-foundation.md` (plano 1) inteiro concluido.

**Fora de escopo:** adapter NestJS, `CacheModule`, `CacheHealthIndicator` do Terminus e a integracao no `core-server` — tudo isso e o plano 3.

## Global Constraints

- **TypeScript cru, sem build.** Nenhum `dist/`, nenhum script `build`. Scripts `.lua` viram constantes TypeScript e nao arquivos `.lua`: sem etapa de build nada copiaria um `.lua` para lugar nenhum, e ler do disco em runtime trocaria um erro de compilacao por um `ENOENT` no primeiro `release`.
- **Nenhuma excecao para falha esperada.** Todo caminho retorna `Either<F, S>` de `@ruguin/utils`. Cuidado com `return failure(x.value)` e nunca `return x`: `Either` carrega o tipo de sucesso nas assinaturas dos type guards, entao um `Failure<E, A>` nao e atribuivel a `Failure<E, B>`.
- **Todo erro estende `BaseError`** de `@ruguin/ddd-kernel` e declara `readonly name` e `readonly status`.
- **Testes:** unitarios em `src/**/__tests__/**/*.unit.ts`, integracao em `src/**/__tests__/**/*.int.ts`. O `vitest.config.ts` do pacote ja tem os dois projetos.
- **Lint deste repo, verificado rodando.** Um parametro nao usado e ERRO (nao existe `argsIgnorePattern`): metodo que ignora o parametro **omite o parametro inteiro**. `async` sem `await` no corpo e ERRO — use `Promise.resolve(...)` ou devolva a Promise do delegado direto. `Number.parseInt(x, 10)` e ERRO (`unicorn/prefer-number-coercion`) — use `Number(x)`. Booleano precisa de prefixo `is`/`has`/`was`/... (`unicorn/consistent-boolean-name`). Classe so com membros estaticos e ERRO (`no-extraneous-class`) — a `CacheFactory` e um objeto `as const`. `let` de modulo reatribuido dentro de `beforeAll` e ERRO (`unicorn/no-top-level-assignment-in-function`) — use um objeto de contexto. `Math.random()` exige `// eslint-disable-next-line sonarjs/pseudo-random -- <motivo>`, com o `--` e a descricao. Imports e exports em ordem alfabetica (`import-sort`). `export namespace ...DTO` e a convencao (`no-namespace` esta off).
- **`crypto.randomUUID()` funciona sem import** (Node 26, `types: ["node"]`, `globals.node` no eslint).
- **Commits:** Conventional Commits, escopo `cache` (ou `infra` na Task 1). **Nunca** adicionar trailer `Co-Authored-By`.

## File Structure

| Arquivo                                                                           | Responsabilidade                                                                   |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `infrastructure/local/docker-compose.yml`                                         | Ganha o servico `redis-replica`, sem o qual o roteamento de leitura nao e testavel |
| `packages/cache/src/infra/apply-ttl-jitter.ts`                                    | Jitter de TTL compartilhado por todos os drivers                                   |
| `packages/cache/src/infra/namespace-version.resolver.ts`                          | Ganha `effectiveConsistency` publico e fonte com erro de operacao                  |
| `packages/cache/src/infra/drivers/valkey/valkey-command.executor.ts`              | Template Method: timeout e traducao de erro do client                              |
| `packages/cache/src/infra/drivers/valkey/connection/valkey-connection.manager.ts` | Master, replicas e a terceira conexao do subscriber                                |
| `packages/cache/src/infra/drivers/valkey/scripts/lua-scripts.ts`                  | Os quatro scripts Lua, com a aridade de KEYS declarada                             |
| `packages/cache/src/infra/drivers/valkey/physical-key.resolver.ts`                | Versao de namespace + montagem da chave fisica                                     |
| `packages/cache/src/infra/drivers/valkey/operations/*.ts`                         | Uma classe por concern: key-value, counter, lock, score, namespace, health         |
| `packages/cache/src/infra/drivers/valkey/invalidation/*.ts`                       | Publisher e subscriber do canal de invalidacao                                     |
| `packages/cache/src/infra/drivers/valkey/valkey-cache.driver.ts`                  | `ICacheDriver` compondo as operations                                              |
| `packages/cache/src/infra/decorators/circuit-breaker.ts`                          | Maquina de estados do breaker, isolada e testavel                                  |
| `packages/cache/src/infra/decorators/resilient-cache.provider.ts`                 | Decorator de resiliencia sobre `ICacheDriver`                                      |
| `packages/cache/src/infra/decorators/observable-cache.provider.ts`                | Decorator de observabilidade sobre `ICacheDriver`                                  |
| `packages/cache/src/domain/errors/invalid-cache-config.error.ts`                  | Erro de composicao mal configurada                                                 |
| `packages/cache/src/factory/cache.factory.ts`                                     | Raiz de composicao: escolhe driver, aplica decorators, devolve o Facade            |
| `packages/cache/src/factory/create-valkey-driver.ts`                              | Fiacao das onze colaboracoes da familia Valkey                                     |

---

### Task 1: Replica local e dependencias do pacote

**Files:**

- Modify: `infrastructure/local/docker-compose.yml`
- Modify: `infrastructure/local/README.md`
- Modify: `packages/cache/package.json`

**Interfaces:**

- Consumes: nada.
- Produces: um Valkey replica em `localhost:6380` replicando de `redis:6379`; `iovalkey` e `@opentelemetry/api` disponiveis em `@ruguin/cache`.

Sem uma replica local, a tabela de roteamento do §8.1 da spec e uma afirmacao que nenhum teste consegue contradizer. Com ela, o proprio servidor prova a regra: uma escrita que chegasse na replica voltaria como `READONLY You can't write against a read only replica.`

- [ ] **Step 1: Adicionar o servico da replica**

Em `infrastructure/local/docker-compose.yml`, logo apos o servico `redis`, no mesmo estilo dos vizinhos (`restart`, `healthcheck`, `logging: *loki-logging`):

```yaml
redis-replica:
  image: valkey/valkey:9-alpine
  restart: unless-stopped
  # Replica de leitura, para que o roteamento master/replica do @ruguin/cache seja
  # exercitavel localmente e nao so em producao. Sem volume: o estado dela vem do master.
  command: ['valkey-server', '--replicaof', 'redis', '6379']
  ports:
    - '6380:6379'
  depends_on:
    redis:
      condition: service_healthy
  healthcheck:
    test: ['CMD', 'valkey-cli', 'ping']
    interval: 5s
    timeout: 5s
    retries: 10
  logging: *loki-logging
```

- [ ] **Step 2: Documentar a porta**

Em `infrastructure/local/README.md`, na tabela de enderecos, logo abaixo da linha `Valkey (Redis)`:

```markdown
| Valkey replica | `localhost:6380` | somente leitura; replica de `redis` |
```

E na descricao do `docker-compose.yml` (primeira lista do arquivo), trocar `Valkey (compativel com o protocolo Redis)` por `Valkey (compativel com o protocolo Redis, com uma replica de leitura)`.

- [ ] **Step 3: Subir e confirmar a replicacao**

```bash
docker compose -f infrastructure/local/docker-compose.yml up -d redis redis-replica
docker exec ruguin-redis-replica-1 valkey-cli info replication | head -5
```

Expected: `role:slave` e `master_link_status:up`. Se aparecer `down`, espere alguns segundos e repita — o primeiro sync leva um instante.

- [ ] **Step 4: Confirmar que a replica recusa escrita**

```bash
docker exec ruguin-redis-replica-1 valkey-cli set probe 1
```

Expected: `READONLY You can't write against a read only replica.` — esse erro e o que a Task 17 transforma em teste.

- [ ] **Step 5: Declarar as dependencias novas**

Em `packages/cache/package.json`, na secao `dependencies` (ordem alfabetica):

```json
  "dependencies": {
    "@opentelemetry/api": "^1.9.1",
    "@ruguin/ddd-kernel": "workspace:*",
    "@ruguin/utils": "workspace:*",
    "iovalkey": "^0.4.0"
  },
```

`@opentelemetry/api` entra como dependencia normal, e nao como peer opcional. A spec §2 a lista entre as peers de `./nestjs`, mas o `ObservableCacheProvider` vive em `infra/decorators/` e sai pelo barrel raiz: qualquer consumidor de `@ruguin/cache` carrega esse import, entao trata-la como opcional daria um `ERR_MODULE_NOT_FOUND` no primeiro `import`.

- [ ] **Step 6: Instalar**

Run: `pnpm install`
Expected: `iovalkey` e `@opentelemetry/api` resolvidos dentro de `packages/cache/node_modules`.

- [ ] **Step 7: Commit**

```bash
git add infrastructure/local/docker-compose.yml infrastructure/local/README.md packages/cache/package.json pnpm-lock.yaml
git commit -m "feat(infra): add a valkey read replica to the local stack"
```

---

### Task 2: Executor de comandos

**Files:**

- Create: `packages/cache/src/infra/drivers/valkey/valkey-command.executor.ts`
- Test: `packages/cache/src/infra/drivers/valkey/__tests__/valkey-command.executor.unit.ts`

**Interfaces:**

- Consumes: `CacheConnectionError`, `CacheTimeoutError` do dominio.
- Produces: `ValkeyCommandExecutor` com `run<T>(input: { command: () => Promise<T>; operation: string; timeoutInMs?: number }): Promise<Either<CacheConnectionError | CacheTimeoutError, T>>`, e o tipo `ValkeyCommandOutput<T>`.

E o Template Method da tabela §1.2: o unico ponto onde uma rejeicao crua do client vira erro de dominio. Sem ele, cada uma das vinte e poucas operacoes inventaria sua propria traducao, e a primeira escrita diferente vazaria um erro do `ioredis` para um chamador que so sabe discriminar os nossos.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// packages/cache/src/infra/drivers/valkey/__tests__/valkey-command.executor.unit.ts
import { describe, expect, it } from 'vitest'

import { ValkeyCommandExecutor } from '../valkey-command.executor'

const never = async (): Promise<string> =>
  new Promise<string>(() => {
    // Deliberately never settles: the executor's own budget is what has to end this call.
  })

describe('ValkeyCommandExecutor', () => {
  it('passes a successful reply straight through', async () => {
    const executor = new ValkeyCommandExecutor({ timeoutInMs: 100 })

    const result = await executor.run({ command: () => Promise.resolve('OK'), operation: 'set' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value).toBe('OK')
  })

  it('turns a client rejection into a connection error naming the operation', async () => {
    const executor = new ValkeyCommandExecutor({ timeoutInMs: 100 })
    const cause = new Error('ECONNREFUSED')

    const result = await executor.run({ command: () => Promise.reject(cause), operation: 'get' })

    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value.name).toBe('CacheConnectionError')
    expect(result.value.message).toContain('get')
    expect(result.value.error).toBe(cause)
  })

  it('gives up on a command that never answers, and says what the budget was', async () => {
    const executor = new ValkeyCommandExecutor({ timeoutInMs: 20 })

    const result = await executor.run({ command: never, operation: 'get' })

    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value.name).toBe('CacheTimeoutError')
    expect(result.value.message).toContain('20')
  })

  /*
   * The health check hands its own budget down so a slow INFO does not fail under the tight
   * per-operation timeout that the hot path is tuned for.
   */
  it('lets a caller override the budget for one call', async () => {
    const executor = new ValkeyCommandExecutor({ timeoutInMs: 10_000 })

    const result = await executor.run({ command: never, operation: 'healthCheck', timeoutInMs: 20 })

    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value.message).toContain('20')
  })
})
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../valkey-command.executor'`.

- [ ] **Step 3: Implementar**

```ts
// packages/cache/src/infra/drivers/valkey/valkey-command.executor.ts
import { type Either, failure, success } from '@ruguin/utils'

import { CacheConnectionError, CacheTimeoutError } from '../../../domain'

export type ValkeyCommandOutput<T> = Promise<Either<CacheConnectionError | CacheTimeoutError, T>>

/*
 * Resolved rather than rejected by the timer, so the race has a single failure channel and the
 * timeout branch needs no second `catch`. A rejecting timer would also force an unused
 * `resolve` parameter on the executor's promise, which this repo's lint bans outright.
 */
const TIMED_OUT: unique symbol = Symbol('valkey-command-timed-out')

/*
 * The one place a raw client rejection becomes a domain error. Every operation funnels through
 * it so the mapping is uniform: without it each of the twenty-odd commands would invent its own
 * translation and the first one written differently would leak an `ioredis` error into a caller
 * that only knows how to switch on ours.
 */
export class ValkeyCommandExecutor {
  private readonly timeoutInMs: number

  constructor(input: { timeoutInMs: number }) {
    this.timeoutInMs = input.timeoutInMs
  }

  public async run<T>(input: {
    command: () => Promise<T>
    operation: string
    timeoutInMs?: number
  }): ValkeyCommandOutput<T> {
    const budgetInMs: number = input.timeoutInMs ?? this.timeoutInMs

    let timer: ReturnType<typeof setTimeout> | undefined

    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        resolve(TIMED_OUT)
      }, budgetInMs)
    })

    try {
      const outcome: T | typeof TIMED_OUT = await Promise.race([input.command(), deadline])

      if (outcome === TIMED_OUT) {
        return failure(new CacheTimeoutError({ operation: input.operation, timeoutInMs: budgetInMs }))
      }

      return success(outcome)
    } catch (error: unknown) {
      return failure(new CacheConnectionError({ operation: input.operation, error }))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
```

O timer **resolve** um simbolo em vez de rejeitar. Rejeitar exigiria a forma `new Promise((_, reject) => ...)`, e o `_` e um parametro nao usado — erro de lint neste repo, sem excecao configurada. Resolver tambem deixa a corrida com um unico canal de falha: o `catch` cuida so do client.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos tres.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src/infra/drivers/valkey
git commit -m "feat(cache): add the valkey command executor with timeout and error mapping"
```

---

### Task 3: Gerenciador de conexoes

**Files:**

- Create: `packages/cache/src/infra/drivers/valkey/connection/valkey-connection.manager.ts`
- Test: `packages/cache/src/infra/drivers/valkey/connection/__tests__/valkey-connection.manager.unit.ts`

**Interfaces:**

- Consumes: `Redis` e `RedisOptions` de `iovalkey`; `CacheConnectionError`, `CacheNotInitializedError` do dominio.
- Produces: `ValkeyConnectionManager` com `connect()`, `disconnect()`, `isConnected()`, `master()`, `reader()`, `replicas()`, `subscriber()`; o tipo `ValkeyReplica`; e a funcao pura `pickReadyReplica`.

Tres tipos de conexao (spec §8.1). A terceira nao e otimizacao: um cliente em modo subscribe recusa comandos normais, entao o canal de invalidacao nao pode dividir o socket do master.

- [ ] **Step 1: Escrever o teste que falha**

O roteamento sai numa funcao pura justamente para ser testavel sem servidor. O resto da classe e I/O e e provado pelos testes de integracao da Task 17.

```ts
// packages/cache/src/infra/drivers/valkey/connection/__tests__/valkey-connection.manager.unit.ts
import { describe, expect, it } from 'vitest'

import { pickReadyReplica } from '../valkey-connection.manager'

const replica = (input: { host: string; status: string }): { client: { status: string }; host: string } => ({
  client: { status: input.status },
  host: input.host
})

describe('pickReadyReplica', () => {
  it('answers null when no replica is configured, so the caller falls back to the master', () => {
    expect(pickReadyReplica({ cursor: 0, replicas: [] })).toBeNull()
  })

  it('walks the list in order as the cursor advances', () => {
    const replicas = [replica({ host: 'a:6379', status: 'ready' }), replica({ host: 'b:6379', status: 'ready' })]

    expect(pickReadyReplica({ cursor: 0, replicas })?.host).toBe('a:6379')
    expect(pickReadyReplica({ cursor: 1, replicas })?.host).toBe('b:6379')
    expect(pickReadyReplica({ cursor: 2, replicas })?.host).toBe('a:6379')
  })

  it('skips a replica that is not ready instead of routing a command at it', () => {
    const replicas = [replica({ host: 'a:6379', status: 'reconnecting' }), replica({ host: 'b:6379', status: 'ready' })]

    expect(pickReadyReplica({ cursor: 0, replicas })?.host).toBe('b:6379')
  })

  /*
   * Null rather than "the least bad option": with every replica down the read has to go to the
   * master, and that is a routing decision the manager makes — not a command that fails first and
   * gets retried somewhere else.
   */
  it('answers null when every replica is down', () => {
    const replicas = [replica({ host: 'a:6379', status: 'close' }), replica({ host: 'b:6379', status: 'reconnecting' })]

    expect(pickReadyReplica({ cursor: 0, replicas })).toBeNull()
  })
})
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../valkey-connection.manager'`.

- [ ] **Step 3: Implementar**

```ts
// packages/cache/src/infra/drivers/valkey/connection/valkey-connection.manager.ts
import { type Either, failure, success } from '@ruguin/utils'
import { Redis, type RedisOptions } from 'iovalkey'

import { CacheConnectionError, CacheNotInitializedError } from '../../../../domain'

export type ValkeyReplica = Readonly<{ client: Redis; host: string }>

type ClientOutput = Either<CacheNotInitializedError, Redis>

/*
 * Both defaults fight fail-open and both are turned off deliberately.
 *
 * `enableOfflineQueue` parks commands issued while the socket is down and replays them on
 * reconnect, so a caller waits for the outage to end instead of missing fast and going to the
 * source. `maxRetriesPerRequest` at its default of 20 turns one dead command into twenty round
 * trips before anyone hears about it. Cache is an optimisation: it has to fail quickly enough
 * for the breaker to notice and for the loader to take over.
 */
const BASE_OPTIONS: RedisOptions = {
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: 1
}

const hostOf = (input: { url: string }): string => {
  try {
    return new URL(input.url).host
  } catch {
    // Only used to label the node in the health payload; an unparseable URL is not fatal here.
    return input.url
  }
}

/*
 * Round-robin over the replicas that are actually ready, starting at the cursor. Returning null
 * rather than an unready client is what makes the fallback to the master a routing decision
 * instead of a command that fails and then has to be retried somewhere else.
 */
export const pickReadyReplica = <T extends { client: { status: string } }>(input: {
  cursor: number
  replicas: readonly T[]
}): T | null => {
  const total: number = input.replicas.length
  if (total === 0) return null

  for (let offset = 0; offset < total; offset += 1) {
    const candidate: T | undefined = input.replicas[(input.cursor + offset) % total]
    if (candidate?.client.status === 'ready') return candidate
  }

  return null
}

export class ValkeyConnectionManager {
  private readonly masterUrl: string
  private readonly options: RedisOptions
  private readonly replicaUrls: readonly string[]
  private readonly withSubscriber: boolean

  private cursor = 0
  private masterClient: Redis | null = null
  private replicaClients: readonly ValkeyReplica[] = []
  private subscriberClient: Redis | null = null

  constructor(input: {
    masterUrl: string
    options?: RedisOptions
    replicaUrls?: readonly string[]
    withSubscriber: boolean
  }) {
    this.masterUrl = input.masterUrl
    this.replicaUrls = input.replicaUrls ?? []
    this.withSubscriber = input.withSubscriber
    this.options = { ...BASE_OPTIONS, ...input.options }
  }

  public async connect(): Promise<Either<CacheConnectionError, true>> {
    if (this.masterClient !== null) return success(true)

    const master: Redis = new Redis(this.masterUrl, this.options)
    const replicas: readonly ValkeyReplica[] = this.replicaUrls.map((url) => ({
      client: new Redis(url, this.options),
      host: hostOf({ url })
    }))

    /*
     * A third connection, and not an optimisation: a client in subscribe mode refuses ordinary
     * commands, so the invalidation channel cannot share the master's socket.
     */
    const subscriber: Redis | null = this.withSubscriber ? new Redis(this.masterUrl, this.options) : null

    try {
      await master.connect()
      if (subscriber !== null) await subscriber.connect()
    } catch (error: unknown) {
      await ValkeyConnectionManager.dispose({ clients: [master, ...replicas.map((r) => r.client), subscriber] })

      return failure(new CacheConnectionError({ operation: 'connect', error }))
    }

    /*
     * A replica that refuses to come up is a degradation, not an outage: reads fall back to the
     * master and healthCheck reports it as degraded. Only the master is fatal.
     */
    await Promise.all(
      replicas.map(async (replica): Promise<void> => {
        try {
          await replica.client.connect()
        } catch {
          // Swallowed on purpose — see above.
        }
      })
    )

    this.masterClient = master
    this.replicaClients = replicas
    this.subscriberClient = subscriber

    return success(true)
  }

  public async disconnect(): Promise<Either<CacheConnectionError, true>> {
    const clients: ReadonlyArray<Redis | null> = [
      this.masterClient,
      ...this.replicaClients.map((replica) => replica.client),
      this.subscriberClient
    ]

    this.masterClient = null
    this.replicaClients = []
    this.subscriberClient = null
    this.cursor = 0

    await ValkeyConnectionManager.dispose({ clients })

    return success(true)
  }

  public isConnected(): boolean {
    return this.masterClient !== null
  }

  public master(): ClientOutput {
    if (this.masterClient === null) return failure(new CacheNotInitializedError({ operation: 'master' }))

    return success(this.masterClient)
  }

  /*
   * Reads in eventual mode land here. Strong reads ask for `master()` by name instead, because
   * "fresh" that comes off a replica which has not seen the INCR yet is not fresh at all.
   */
  public reader(): ClientOutput {
    if (this.masterClient === null) return failure(new CacheNotInitializedError({ operation: 'reader' }))

    const picked: ValkeyReplica | null = pickReadyReplica({ cursor: this.cursor, replicas: this.replicaClients })
    this.cursor = this.replicaClients.length === 0 ? 0 : (this.cursor + 1) % this.replicaClients.length

    return success(picked?.client ?? this.masterClient)
  }

  public replicas(): readonly ValkeyReplica[] {
    return this.replicaClients
  }

  public subscriber(): ClientOutput {
    if (this.subscriberClient === null) return failure(new CacheNotInitializedError({ operation: 'subscriber' }))

    return success(this.subscriberClient)
  }

  private static async dispose(input: { clients: ReadonlyArray<Redis | null> }): Promise<void> {
    await Promise.all(
      input.clients.map(async (client): Promise<void> => {
        if (client === null || client.status === 'end') return

        try {
          await client.quit()
        } catch {
          /*
           * Teardown is not actionable: a socket that will not close politely is closed rudely.
           * Surfacing this would make shutdown fail for a connection nobody will use again.
           */
          client.disconnect()
        }
      })
    )
  }
}
```

Duas escolhas nao obvias, ambas contra os defaults do `ioredis`. `enableOfflineQueue: false` porque a fila de offline faz o chamador esperar a queda terminar em vez de dar miss rapido e ir na fonte — o oposto do fail-open. `maxRetriesPerRequest: 1` porque o default de 20 transforma um comando morto em vinte round-trips antes que alguem fique sabendo, e o breaker precisa da falha para reagir.

A falha de uma replica no `connect` e engolida de proposito: leitura cai no master e o health reporta `degraded`. So o master e fatal.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos tres.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src/infra/drivers/valkey
git commit -m "feat(cache): add the valkey connection manager with replica routing"
```

---

### Task 4: Scripts Lua

**Files:**

- Create: `packages/cache/src/infra/drivers/valkey/scripts/lua-scripts.ts`
- Test: `packages/cache/src/infra/drivers/valkey/scripts/__tests__/lua-scripts.unit.ts`

**Interfaces:**

- Consumes: nada.
- Produces: `LuaScript` (`{ numberOfKeys: number; source: string }`) e as quatro constantes `RELEASE_LOCK_SCRIPT`, `EXTEND_LOCK_SCRIPT`, `GET_WITH_NAMESPACE_VERSION_SCRIPT`, `BUMP_NAMESPACE_VERSION_SCRIPT`.

Sao quatro e nao tres. A spec §4 cita apenas o de leitura forte, mas `INCR` numa chave ausente devolve `1` — e ausente ja significa versao 1, de modo que a primeira invalidacao de um namespace nao invalidaria nada. `BUMP_NAMESPACE_VERSION_SCRIPT` le e grava `atual + 1` no mesmo `EVAL`, preservando a convencao "ausente e 1" que o script de leitura tambem codifica.

- [ ] **Step 1: Escrever o teste que falha**

`numberOfKeys` e a fronteira que o `EVAL` usa entre `KEYS` e `ARGV`. Errar isso nao falha alto: o servidor simplesmente le o primeiro `ARGV` do chamador como chave. Fixar o numero no que o fonte referencia e a guarda barata contra esse deslocamento silencioso.

```ts
// packages/cache/src/infra/drivers/valkey/scripts/__tests__/lua-scripts.unit.ts
import { describe, expect, it } from 'vitest'

import {
  BUMP_NAMESPACE_VERSION_SCRIPT,
  EXTEND_LOCK_SCRIPT,
  GET_WITH_NAMESPACE_VERSION_SCRIPT,
  type LuaScript,
  RELEASE_LOCK_SCRIPT
} from '../lua-scripts'

const highestKeyIndex = (input: { source: string }): number => {
  const matches: readonly string[] = input.source.match(/KEYS\[\d+\]/gu) ?? []

  let highest = 0
  for (const match of matches) highest = Math.max(highest, Number(match.slice(5, -1)))

  return highest
}

const scripts: ReadonlyArray<readonly [string, LuaScript]> = [
  ['release lock', RELEASE_LOCK_SCRIPT],
  ['extend lock', EXTEND_LOCK_SCRIPT],
  ['get with namespace version', GET_WITH_NAMESPACE_VERSION_SCRIPT],
  ['bump namespace version', BUMP_NAMESPACE_VERSION_SCRIPT]
]

describe('lua scripts', () => {
  /*
   * numberOfKeys is passed to EVAL as the boundary between KEYS and ARGV. Getting it wrong does
   * not fail loudly — the server simply reads the caller's first ARGV as a key — so pinning it to
   * what the source actually references is the cheap guard against a silent mis-slot.
   */
  it.each(scripts)('declares the key count %s actually references', (_name, script) => {
    expect(script.numberOfKeys).toBe(highestKeyIndex({ source: script.source }))
  })

  it('compares the token before releasing, instead of deleting blindly', () => {
    expect(RELEASE_LOCK_SCRIPT.source).toContain("redis.call('GET', KEYS[1]) == ARGV[1]")
    expect(RELEASE_LOCK_SCRIPT.source).toContain("redis.call('DEL', KEYS[1])")
  })

  it('compares the token before extending, for the same reason', () => {
    expect(EXTEND_LOCK_SCRIPT.source).toContain("redis.call('GET', KEYS[1]) == ARGV[1]")
    expect(EXTEND_LOCK_SCRIPT.source).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[2])")
  })

  it('treats an absent namespace version as 1 on both read and bump', () => {
    expect(GET_WITH_NAMESPACE_VERSION_SCRIPT.source).toContain("or '1'")
    expect(BUMP_NAMESPACE_VERSION_SCRIPT.source).toContain("or '1'")
  })
})
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../lua-scripts'`.

- [ ] **Step 3: Implementar**

```ts
// packages/cache/src/infra/drivers/valkey/scripts/lua-scripts.ts
export type LuaScript = Readonly<{ numberOfKeys: number; source: string }>

/*
 * Compare-and-swap on the token, never a bare DEL. A process whose lock already expired would
 * otherwise delete the lock a *different* process acquired after it, which is exactly the
 * mutual exclusion the lock exists to provide being handed to two owners at once.
 */
export const RELEASE_LOCK_SCRIPT: LuaScript = {
  numberOfKeys: 1,
  source: `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`
}

// Same compare-and-swap: extending a lock you no longer own is the same bug as releasing it.
export const EXTEND_LOCK_SCRIPT: LuaScript = {
  numberOfKeys: 1,
  source: `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`
}

/*
 * Strong read in a single round trip. A pipeline cannot express this: the second command's key
 * depends on the *value* the first returns, and a pipeline carries no data dependency between
 * its commands. Lua is what collapses "resolve the version, then read under it" into one hop.
 *
 * The reply is a table so the caller can refresh its local memo with the version it just read.
 * A missing value shortens the table to one element instead of appearing as nil, because a nil
 * inside a Lua table truncates it — `{ version, nil }` and `{ version }` are the same value,
 * and the caller would have no way to tell "no such key" from a malformed reply.
 */
export const GET_WITH_NAMESPACE_VERSION_SCRIPT: LuaScript = {
  numberOfKeys: 1,
  source: `
local version = redis.call('GET', KEYS[1]) or '1'
local value = redis.call('GET', ARGV[1] .. ':v' .. version .. ':' .. ARGV[2])
if value == false then return { version } end
return { version, value }
`
}

/*
 * An absent version key means version 1, so a plain INCR would be a no-op invalidation: it
 * returns 1 on a missing key, leaving readers on the very version the caller asked to retire.
 * Reading the current value and writing current + 1 keeps the "absent means 1" convention that
 * the read script above encodes, and stays atomic.
 */
export const BUMP_NAMESPACE_VERSION_SCRIPT: LuaScript = {
  numberOfKeys: 1,
  source: `
local current = tonumber(redis.call('GET', KEYS[1]) or '1')
local bumped = current + 1
redis.call('SET', KEYS[1], bumped)
return bumped
`
}
```

A tabela de retorno do script de leitura tem uma sutileza de Lua que o formato depende: `nil` dentro de uma tabela a trunca, entao `{ version, nil }` e `{ version }` sao o mesmo valor. Encurtar a tabela de proposito quando o valor nao existe e o que da ao chamador duas respostas distinguiveis.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos tres.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src/infra/drivers/valkey
git commit -m "feat(cache): add the valkey lua scripts for locks and namespace versions"
```

---

### Task 5: Publisher de invalidacao e ajuste do resolver

**Files:**

- Create: `packages/cache/src/infra/drivers/valkey/invalidation/invalidation-publisher.ts`
- Test: `packages/cache/src/infra/drivers/valkey/invalidation/__tests__/invalidation-publisher.unit.ts`
- Modify: `packages/cache/src/infra/namespace-version.resolver.ts`
- Modify: `packages/cache/src/infra/__tests__/namespace-version.resolver.unit.ts`

**Interfaces:**

- Consumes: `OnCacheError` de `application/`; `ValkeyConnectionManager`; `ValkeyCommandExecutor`.
- Produces: `InvalidationMessage`, `invalidationChannelOf`, `encodeInvalidation`, `decodeInvalidation`, `InvalidationPublisher.publish(input: InvalidationMessage): Promise<void>`.
- Modifica: `NamespaceVersionSource.fetchVersion` passa a devolver `Either<CacheOperationError, ...>`; `NamespaceVersionResolver.effectiveConsistency` passa de privado a publico.

Duas mudancas no resolver do plano 1, ambas forcadas pelo driver de rede:

1. **A fonte falha com `CacheOperationError`.** Um namespace invalido produz `InvalidCacheKeyError`, e espremer isso num `CacheConnectionError` seria mentir sobre a causa. `ResolveNamespaceVersionProviderDTO.OutputError` ja e `CacheOperationError`, entao a propagacao continua tipando.
2. **`effectiveConsistency` fica publico.** A cascata decide mais do que a busca da versao: com replicas de leitura, o **comando** tem de ir para o mesmo no de onde a versao veio. Uma leitura forte que resolvesse a versao no master e depois lesse numa replica sem o `INCR` devolveria exatamente o dado velho que o modo existe para eliminar.

- [ ] **Step 1: Escrever o teste da cascata que falha**

Acrescente ao final de `packages/cache/src/infra/__tests__/namespace-version.resolver.unit.ts` um `describe` novo, irmao do que ja existe — a cascata e uma decisao sincrona sobre configuracao, nao um caminho de resolucao de versao, e aninha-la sob `NamespaceVersionResolver` misturaria as duas:

```ts
/*
 * Exposed because the cascade decides more than the version lookup: a driver with read replicas
 * has to route the *command* to the same node the version came from, and a strong read served
 * off a replica whose INCR has not landed is the stale answer the mode exists to rule out.
 */
describe('effectiveConsistency', () => {
  it('lets the call override everything', () => {
    const resolver = resolverWith({ user: { consistency: CacheConsistency.EVENTUAL } })

    expect(resolver.effectiveConsistency({ namespace: 'user', consistency: CacheConsistency.STRONG })).toBe(
      CacheConsistency.STRONG
    )
  })

  it('falls back to the namespace declaration, which is the preferred place to state it', () => {
    const resolver = resolverWith({ 'api-key': { consistency: CacheConsistency.STRONG } })

    expect(resolver.effectiveConsistency({ namespace: 'api-key' })).toBe(CacheConsistency.STRONG)
  })

  it('falls back to the global default for an undeclared namespace', () => {
    const resolver = resolverWith({ 'api-key': { consistency: CacheConsistency.STRONG } })

    expect(resolver.effectiveConsistency({ namespace: 'session' })).toBe(CacheConsistency.EVENTUAL)
  })
})
```

E, no topo do arquivo, logo antes de `const failingSource`, o helper que os tres casos usam. Ele fica no escopo do modulo porque `unicorn/consistent-function-scoping` recusa arrow declarada dentro de `describe` sem capturar nada dele:

```ts
const resolverWith = (namespaces: Record<string, { consistency?: CacheConsistency }>): NamespaceVersionResolver =>
  new NamespaceVersionResolver({
    source: sourceReturning([1]).source,
    defaultConsistency: CacheConsistency.EVENTUAL,
    localTtlInMs: 5000,
    namespaces
  })
```

- [ ] **Step 2: Escrever o teste do payload que falha**

```ts
// packages/cache/src/infra/drivers/valkey/invalidation/__tests__/invalidation-publisher.unit.ts
import { describe, expect, it } from 'vitest'

import { decodeInvalidation, encodeInvalidation, invalidationChannelOf } from '../invalidation-publisher'

describe('invalidation payload', () => {
  it('namespaces the channel by prefix, so two services never cross-invalidate', () => {
    expect(invalidationChannelOf({ prefix: 'ruguin:iam' })).toBe('ruguin:iam:__invalidation__')
  })

  it('round-trips a message', () => {
    const encoded: string = encodeInvalidation({ namespace: 'user', version: 8 })

    expect(decodeInvalidation({ raw: encoded })).toEqual({ namespace: 'user', version: 8 })
  })

  /*
   * Anything can land on a Pub/Sub channel — another service, an operator with valkey-cli, an
   * older build. Every one of these has to be droppable without touching the memo, because a
   * half-applied message would move a version the server never reached.
   */
  it.each([
    ['not json at all', 'definitely not json'],
    ['a json scalar', '"user"'],
    ['null', 'null'],
    ['a missing namespace', '{"version":8}'],
    ['an empty namespace', '{"namespace":"","version":8}'],
    ['a missing version', '{"namespace":"user"}'],
    ['a non-numeric version', '{"namespace":"user","version":"8"}'],
    ['a fractional version', '{"namespace":"user","version":8.5}']
  ])('drops %s', (_name, raw) => {
    expect(decodeInvalidation({ raw })).toBeNull()
  })
})
```

- [ ] **Step 3: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `effectiveConsistency` nao existe e `Cannot find module '../invalidation-publisher'`.

- [ ] **Step 4: Ajustar o resolver**

Substitua `packages/cache/src/infra/namespace-version.resolver.ts` por:

```ts
// packages/cache/src/infra/namespace-version.resolver.ts
import { type Either, failure, success } from '@ruguin/utils'

import {
  CacheConsistency,
  type CacheOperationError,
  type IResolveNamespaceVersionProvider,
  type ResolveNamespaceVersionProviderDTO
} from '../domain'

export type NamespaceVersionSource = Readonly<{
  fetchVersion: (input: {
    namespace: string
    consistency: CacheConsistency
  }) => Promise<Either<CacheOperationError, Readonly<{ version: number }>>>
}>

export type NamespaceConfig = Readonly<Record<string, Readonly<{ consistency?: CacheConsistency }>>>

type MemoEntry = Readonly<{ version: number; expiresAt: number }>

const INITIAL_VERSION = 1

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
    const consistency: CacheConsistency = this.effectiveConsistency(input)

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

  /*
   * Public because the cascade decides more than the version lookup: a driver with read
   * replicas has to route the *command* to the same node the version came from, and a strong
   * read served off a replica whose INCR has not landed is the stale answer the mode exists to
   * rule out. One implementation of the precedence, consulted by both.
   */
  public effectiveConsistency(input: ResolveNamespaceVersionProviderDTO.Input): CacheConsistency {
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

- [ ] **Step 5: Implementar o publisher**

```ts
// packages/cache/src/infra/drivers/valkey/invalidation/invalidation-publisher.ts
import { type OnCacheError } from '../../../../application/on-cache-error'
import { type ValkeyConnectionManager } from '../connection/valkey-connection.manager'
import { type ValkeyCommandExecutor } from '../valkey-command.executor'

export type InvalidationMessage = Readonly<{ namespace: string; version: number }>

export const invalidationChannelOf = (input: { prefix: string }): string => `${input.prefix}:__invalidation__`

export const encodeInvalidation = (input: InvalidationMessage): string => JSON.stringify(input)

/*
 * Anything can land on a Pub/Sub channel — another service, an operator with valkey-cli, an
 * older build of this package. A malformed payload has to be droppable without touching the
 * memo, so the decoder answers null instead of throwing or half-applying.
 */
export const decodeInvalidation = (input: { raw: string }): InvalidationMessage | null => {
  let parsed: unknown

  try {
    parsed = JSON.parse(input.raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null

  const candidate: Partial<Record<keyof InvalidationMessage, unknown>> = parsed

  if (typeof candidate.namespace !== 'string' || candidate.namespace.length === 0) return null
  if (typeof candidate.version !== 'number' || !Number.isSafeInteger(candidate.version)) return null

  return { namespace: candidate.namespace, version: candidate.version }
}

/*
 * Fire-and-forget by design (spec §4.3): the INCR that precedes it is what actually invalidates
 * the namespace, and the memo TTL is what bounds the window if this message never lands. A
 * publish that failed therefore reports and returns — turning it into a failure of
 * `invalidateNamespace` would make an already-successful invalidation look like it did not
 * happen, and callers would retry an INCR that does not need retrying.
 */
export class InvalidationPublisher {
  private readonly channel: string
  private readonly connections: ValkeyConnectionManager
  private readonly executor: ValkeyCommandExecutor
  private readonly onCacheError: OnCacheError

  constructor(input: {
    connections: ValkeyConnectionManager
    executor: ValkeyCommandExecutor
    onCacheError: OnCacheError
    prefix: string
  }) {
    this.connections = input.connections
    this.executor = input.executor
    this.onCacheError = input.onCacheError
    this.channel = invalidationChannelOf({ prefix: input.prefix })
  }

  public async publish(input: InvalidationMessage): Promise<void> {
    const master = this.connections.master()
    if (master.isFailure()) {
      this.report({ error: master.value, namespace: input.namespace })
      return
    }

    const client = master.value
    const payload: string = encodeInvalidation(input)

    const published = await this.executor.run({
      command: () => client.publish(this.channel, payload),
      operation: 'publishInvalidation'
    })

    if (published.isFailure()) this.report({ error: published.value, namespace: input.namespace })
  }

  private report(input: { error: unknown; namespace: string }): void {
    this.onCacheError({
      error: input.error,
      key: this.channel,
      namespace: input.namespace,
      operation: 'publishInvalidation'
    })
  }
}
```

`publish` devolve `Promise<void>`, nao `Either`. E deliberado: o `INCR` que vem antes e o que de fato invalida o namespace, e o TTL do memo e o teto da janela se a mensagem se perder. Transformar um publish falho em falha de `invalidateNamespace` faria uma invalidacao ja bem-sucedida parecer nao ter acontecido, e o chamador repetiria um `INCR` que nao precisa de repeticao.

- [ ] **Step 6: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos tres. Os testes do plano 1 para o resolver continuam verdes — a assinatura mudou, o comportamento nao.

- [ ] **Step 7: Commit**

```bash
git add packages/cache/src
git commit -m "feat(cache): add the invalidation publisher and expose the consistency cascade"
```

---

### Task 6: Operacoes de namespace e resolucao de chave fisica

**Files:**

- Create: `packages/cache/src/infra/drivers/valkey/operations/namespace.operations.ts`
- Create: `packages/cache/src/infra/drivers/valkey/physical-key.resolver.ts`

**Interfaces:**

- Consumes: `KeyBuilder`, `NamespaceVersionResolver`, `ValkeyConnectionManager`, `ValkeyCommandExecutor`, `InvalidationPublisher`, `BUMP_NAMESPACE_VERSION_SCRIPT`.
- Produces: `NamespaceOperations` com `fetchVersion(input: { consistency: CacheConsistency; namespace: string })` e `invalidate(input: InvalidateNamespaceProviderDTO.Input)`; `PhysicalKeyResolver` com `consistencyFor(...)` e `physicalKey(...)`.

`NamespaceOperations.fetchVersion` e exatamente a forma que `NamespaceVersionSource` pede — e assim que a Task 16 pluga a rede debaixo do resolver puro do plano 1, sem que o resolver saiba o que e um socket.

Estas duas classes nao ganham teste unitario proprio: uma so faz I/O e a outra so encadeia duas chamadas ja testadas. Ambas sao exercitadas de ponta a ponta pelos testes de integracao da Task 17, e `check:types` e o portao imediato.

- [ ] **Step 1: Implementar as operacoes de namespace**

```ts
// packages/cache/src/infra/drivers/valkey/operations/namespace.operations.ts
import { type Either, failure, success } from '@ruguin/utils'

import { CacheConsistency, type CacheOperationError, type InvalidateNamespaceProviderDTO } from '../../../../domain'
import { type KeyBuilder } from '../../../key-builder'
import { type ValkeyConnectionManager } from '../connection/valkey-connection.manager'
import { type InvalidationPublisher } from '../invalidation/invalidation-publisher'
import { BUMP_NAMESPACE_VERSION_SCRIPT } from '../scripts/lua-scripts'
import { type ValkeyCommandExecutor } from '../valkey-command.executor'

const INITIAL_VERSION = 1

type FetchVersionOutput = Promise<Either<CacheOperationError, Readonly<{ version: number }>>>

/*
 * EVAL answers `unknown` and GET answers a string, so both shapes land here. An absent or
 * unreadable version means 1 — the same default the read script encodes — rather than 0, which
 * KeyBuilder would reject and turn a missing version key into a hard failure on every read.
 */
const toVersion = (input: { raw: unknown }): number => {
  if (typeof input.raw === 'number') {
    return Number.isSafeInteger(input.raw) && input.raw >= INITIAL_VERSION ? input.raw : INITIAL_VERSION
  }

  if (typeof input.raw !== 'string') return INITIAL_VERSION

  const parsed = Number(input.raw)

  return Number.isSafeInteger(parsed) && parsed >= INITIAL_VERSION ? parsed : INITIAL_VERSION
}

export class NamespaceOperations {
  private readonly connections: ValkeyConnectionManager
  private readonly executor: ValkeyCommandExecutor
  private readonly keyBuilder: KeyBuilder
  private readonly publisher: InvalidationPublisher | null

  constructor(input: {
    connections: ValkeyConnectionManager
    executor: ValkeyCommandExecutor
    keyBuilder: KeyBuilder
    publisher: InvalidationPublisher | null
  }) {
    this.connections = input.connections
    this.executor = input.executor
    this.keyBuilder = input.keyBuilder
    this.publisher = input.publisher
  }

  public async fetchVersion(input: { consistency: CacheConsistency; namespace: string }): FetchVersionOutput {
    const key = this.keyBuilder.buildVersionKey({ namespace: input.namespace })
    if (key.isFailure()) return failure(key.value)

    /*
     * Strong mode reads the master. The INCR lands there, so a replica that has not replayed it
     * yet would answer with precisely the version the caller paid to bypass.
     */
    const client = input.consistency === CacheConsistency.STRONG ? this.connections.master() : this.connections.reader()
    if (client.isFailure()) return failure(client.value)

    const versionKey: string = key.value.physicalKey
    const connection = client.value

    const raw = await this.executor.run({
      command: () => connection.get(versionKey),
      operation: 'resolveNamespaceVersion'
    })
    if (raw.isFailure()) return failure(raw.value)

    return success({ version: toVersion({ raw: raw.value }) })
  }

  public async invalidate(input: InvalidateNamespaceProviderDTO.Input): InvalidateNamespaceProviderDTO.Output {
    const key = this.keyBuilder.buildVersionKey({ namespace: input.namespace })
    if (key.isFailure()) return failure(key.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const versionKey: string = key.value.physicalKey
    const connection = master.value

    const bumped = await this.executor.run({
      command: () =>
        connection.eval(BUMP_NAMESPACE_VERSION_SCRIPT.source, BUMP_NAMESPACE_VERSION_SCRIPT.numberOfKeys, versionKey),
      operation: 'invalidateNamespace'
    })
    if (bumped.isFailure()) return failure(bumped.value)

    const version: number = toVersion({ raw: bumped.value })

    /*
     * Published after the bump, never before. A subscriber that memoised the new version while
     * the write was still in flight would build keys under a version the server had not reached,
     * and every read in that gap would miss against a key nobody had written yet.
     */
    if (this.publisher !== null) await this.publisher.publish({ namespace: input.namespace, version })

    return success({ version })
  }
}
```

- [ ] **Step 2: Implementar o resolvedor de chave fisica**

```ts
// packages/cache/src/infra/drivers/valkey/physical-key.resolver.ts
import { type Either, failure, success } from '@ruguin/utils'

import { type CacheConsistency, type CacheOperationError } from '../../../domain'
import { type KeyBuilder } from '../../key-builder'
import { type NamespaceVersionResolver } from '../../namespace-version.resolver'

type PhysicalKeyOutput = Promise<Either<CacheOperationError, string>>

/*
 * Every namespaced command needs the same two steps — resolve the namespace version, then fold
 * it into the physical key — and getting the order or the failure handling wrong in one of the
 * fifteen call sites is the kind of bug that only shows up as a permanent miss on one operation.
 */
export class PhysicalKeyResolver {
  private readonly keyBuilder: KeyBuilder
  private readonly versions: NamespaceVersionResolver

  constructor(input: { keyBuilder: KeyBuilder; versions: NamespaceVersionResolver }) {
    this.keyBuilder = input.keyBuilder
    this.versions = input.versions
  }

  public consistencyFor(input: { consistency?: CacheConsistency; namespace: string }): CacheConsistency {
    return this.versions.effectiveConsistency(input)
  }

  public async physicalKey(input: {
    consistency?: CacheConsistency
    key: string
    namespace: string
  }): PhysicalKeyOutput {
    const version = await this.versions.resolveNamespaceVersion(input)
    if (version.isFailure()) return failure(version.value)

    const built = this.keyBuilder.build({
      key: input.key,
      namespace: input.namespace,
      version: version.value.version
    })
    if (built.isFailure()) return failure(built.value)

    return success(built.value.physicalKey)
  }
}
```

- [ ] **Step 3: Rodar e confirmar que compila**

Run: `pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint && pnpm --filter @ruguin/cache test:unit`
Expected: PASS nos tres.

- [ ] **Step 4: Commit**

```bash
git add packages/cache/src/infra/drivers/valkey
git commit -m "feat(cache): add valkey namespace operations and physical key resolution"
```

---

### Task 7: Jitter compartilhado e operacoes de chave-valor

**Files:**

- Create: `packages/cache/src/infra/apply-ttl-jitter.ts`
- Test: `packages/cache/src/infra/__tests__/apply-ttl-jitter.unit.ts`
- Modify: `packages/cache/src/infra/drivers/memory/memory-cache.driver.ts`
- Create: `packages/cache/src/infra/drivers/valkey/operations/key-value.operations.ts`

**Interfaces:**

- Consumes: `applyTtlJitter`, `KeyBuilder`, `NamespaceVersionResolver`, `PhysicalKeyResolver`, `ValkeyConnectionManager`, `ValkeyCommandExecutor`, `ISerializerStrategy`, `GET_WITH_NAMESPACE_VERSION_SCRIPT`.
- Produces: `applyTtlJitter(input: { applyJitter?: boolean; defaultTtlInMs: number; jitterRatio: number; ttlInMs?: number }): number`; `KeyValueOperations` com `get`, `set`, `delete`, `setIfNotExists`.

O jitter sai do driver `memory` para um helper compartilhado antes de o driver Valkey precisar dele. Os drivers diferem em onde os bytes caem, nao em como um TTL e escolhido, e duas copias divergiriam no dia em que uma delas fosse ajustada.

- [ ] **Step 1: Escrever o teste do jitter que falha**

```ts
// packages/cache/src/infra/__tests__/apply-ttl-jitter.unit.ts
import { describe, expect, it } from 'vitest'

import { applyTtlJitter } from '../apply-ttl-jitter'

describe('applyTtlJitter', () => {
  it('falls back to the configured default when the caller gives no ttl', () => {
    expect(applyTtlJitter({ applyJitter: false, defaultTtlInMs: 300_000, jitterRatio: 0.1, ttlInMs: undefined })).toBe(
      300_000
    )
  })

  it('returns the ttl untouched when jitter is switched off for the call', () => {
    expect(applyTtlJitter({ applyJitter: false, defaultTtlInMs: 1000, jitterRatio: 0.5, ttlInMs: 5000 })).toBe(5000)
  })

  it('returns the ttl untouched when the ratio is zero', () => {
    expect(applyTtlJitter({ applyJitter: undefined, defaultTtlInMs: 1000, jitterRatio: 0, ttlInMs: 5000 })).toBe(5000)
  })

  /*
   * The spread is what keeps a thousand keys written by one deploy from expiring in the same
   * millisecond and bringing the stampede back in waves.
   */
  it('stays inside the ratio band when jitter is on', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ttl: number = applyTtlJitter({
        applyJitter: undefined,
        defaultTtlInMs: 1000,
        jitterRatio: 0.1,
        ttlInMs: 10_000
      })

      expect(ttl).toBeGreaterThanOrEqual(9000)
      expect(ttl).toBeLessThanOrEqual(11_000)
    }
  })

  it('never produces a non-positive ttl, which Valkey would reject', () => {
    expect(applyTtlJitter({ applyJitter: undefined, defaultTtlInMs: 1, jitterRatio: 1, ttlInMs: 1 })).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../apply-ttl-jitter'`.

- [ ] **Step 3: Implementar o helper**

```ts
// packages/cache/src/infra/apply-ttl-jitter.ts
/*
 * Spreads expiries so a batch of keys written together does not all die in the same
 * millisecond. Shared by every driver: the drivers differ in where the bytes land, not in how
 * a TTL is chosen, and two copies of this would drift the moment one of them is tuned.
 */
export const applyTtlJitter = (input: {
  applyJitter: boolean | undefined
  defaultTtlInMs: number
  jitterRatio: number
  ttlInMs: number | undefined
}): number => {
  const base: number = input.ttlInMs ?? input.defaultTtlInMs
  if (input.applyJitter === false || input.jitterRatio === 0) return base

  const spread: number = base * input.jitterRatio

  // eslint-disable-next-line sonarjs/pseudo-random -- TTL jitter is a load-spreading heuristic, not a security primitive
  return Math.max(1, Math.round(base - spread + Math.random() * spread * 2))
}
```

- [ ] **Step 4: Fazer o driver `memory` delegar**

Em `packages/cache/src/infra/drivers/memory/memory-cache.driver.ts`, adicione o import logo apos o bloco de `'../../../domain'`:

```ts
import { applyTtlJitter } from '../../apply-ttl-jitter'
```

E substitua o metodo privado inteiro:

```ts
  private effectiveTtl(input: { ttlInMs?: number; applyJitter?: boolean }): number {
    return applyTtlJitter({
      applyJitter: input.applyJitter,
      defaultTtlInMs: this.defaultTtlInMs,
      jitterRatio: this.jitterRatio,
      ttlInMs: input.ttlInMs
    })
  }
```

Os testes do driver `memory` do plano 1 sao a rede de seguranca desta extracao: o comportamento e identico, so mudou de casa.

- [ ] **Step 5: Implementar as operacoes de chave-valor**

```ts
// packages/cache/src/infra/drivers/valkey/operations/key-value.operations.ts
import { type Either, failure, success } from '@ruguin/utils'

import {
  CacheConsistency,
  type DeleteCacheProviderDTO,
  type GetCacheProviderDTO,
  type ISerializerStrategy,
  type SetCacheProviderDTO,
  type SetIfNotExistsCacheProviderDTO
} from '../../../../domain'
import { applyTtlJitter } from '../../../apply-ttl-jitter'
import { type KeyBuilder } from '../../../key-builder'
import { type NamespaceVersionResolver } from '../../../namespace-version.resolver'
import { type ValkeyConnectionManager } from '../connection/valkey-connection.manager'
import { type PhysicalKeyResolver } from '../physical-key.resolver'
import { GET_WITH_NAMESPACE_VERSION_SCRIPT } from '../scripts/lua-scripts'
import { type ValkeyCommandExecutor } from '../valkey-command.executor'

type ReadOutput<T> = Either<GetCacheProviderDTO.OutputError, GetCacheProviderDTO.OutputSuccess<T>>

const MISS = { found: false, value: null } as const

const toStringArray = (input: { value: unknown }): readonly string[] => {
  if (!Array.isArray(input.value)) return []

  const entries: readonly unknown[] = input.value

  return entries.filter((entry: unknown): entry is string => typeof entry === 'string')
}

export class KeyValueOperations {
  private readonly connections: ValkeyConnectionManager
  private readonly defaultTtlInMs: number
  private readonly executor: ValkeyCommandExecutor
  private readonly jitterRatio: number
  private readonly keyBuilder: KeyBuilder
  private readonly keys: PhysicalKeyResolver
  private readonly prefix: string
  private readonly serializer: ISerializerStrategy
  private readonly versions: NamespaceVersionResolver

  constructor(input: {
    connections: ValkeyConnectionManager
    defaultTtlInMs: number
    executor: ValkeyCommandExecutor
    jitterRatio: number
    keyBuilder: KeyBuilder
    keys: PhysicalKeyResolver
    prefix: string
    serializer: ISerializerStrategy
    versions: NamespaceVersionResolver
  }) {
    this.connections = input.connections
    this.defaultTtlInMs = input.defaultTtlInMs
    this.executor = input.executor
    this.jitterRatio = input.jitterRatio
    this.keyBuilder = input.keyBuilder
    this.keys = input.keys
    this.prefix = input.prefix
    this.serializer = input.serializer
    this.versions = input.versions
  }

  public get<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    const consistency: CacheConsistency = this.keys.consistencyFor(input)

    return consistency === CacheConsistency.STRONG ? this.getStrong<T>(input) : this.getEventual<T>(input)
  }

  public async set<T>(input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output {
    const key = await this.keys.physicalKey(input)
    if (key.isFailure()) return failure(key.value)

    const serialized = this.serializer.serialize({ value: input.value })
    if (serialized.isFailure()) return failure(serialized.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const physicalKey: string = key.value
    const payload: string = serialized.value.serialized
    const ttlInMs: number = applyTtlJitter({
      applyJitter: input.applyJitter,
      defaultTtlInMs: this.defaultTtlInMs,
      jitterRatio: this.jitterRatio,
      ttlInMs: input.ttlInMs
    })

    const stored = await this.executor.run({
      command: () => connection.set(physicalKey, payload, 'PX', ttlInMs),
      operation: 'set'
    })
    if (stored.isFailure()) return failure(stored.value)

    return success({ expiresAt: new Date(Date.now() + ttlInMs) })
  }

  public async delete(input: DeleteCacheProviderDTO.Input): DeleteCacheProviderDTO.Output {
    const key = await this.keys.physicalKey(input)
    if (key.isFailure()) return failure(key.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const physicalKey: string = key.value

    const removed = await this.executor.run({
      command: () => connection.del(physicalKey),
      operation: 'delete'
    })
    if (removed.isFailure()) return failure(removed.value)

    return success({ existed: removed.value > 0 })
  }

  public async setIfNotExists<T>(
    input: SetIfNotExistsCacheProviderDTO.Input<T>
  ): SetIfNotExistsCacheProviderDTO.Output {
    const key = await this.keys.physicalKey(input)
    if (key.isFailure()) return failure(key.value)

    const serialized = this.serializer.serialize({ value: input.value })
    if (serialized.isFailure()) return failure(serialized.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const physicalKey: string = key.value
    const payload: string = serialized.value.serialized
    const ttlInMs: number = input.ttlInMs

    const stored = await this.executor.run({
      command: () => connection.set(physicalKey, payload, 'PX', ttlInMs, 'NX'),
      operation: 'setIfNotExists'
    })
    if (stored.isFailure()) return failure(stored.value)

    // A null reply is SET NX declining because the key was there — idempotency, not a failure.
    return success({ stored: stored.value === 'OK' })
  }

  private async getEventual<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    const key = await this.keys.physicalKey({ ...input, consistency: CacheConsistency.EVENTUAL })
    if (key.isFailure()) return failure(key.value)

    const reader = this.connections.reader()
    if (reader.isFailure()) return failure(reader.value)

    const connection = reader.value
    const physicalKey: string = key.value

    const raw = await this.executor.run({
      command: () => connection.get(physicalKey),
      operation: 'get'
    })
    if (raw.isFailure()) return failure(raw.value)
    if (raw.value === null) return success(MISS)

    return this.decode<T>({ raw: raw.value, validate: input.validate })
  }

  private async getStrong<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    const versionKey = this.keyBuilder.buildVersionKey({ namespace: input.namespace })
    if (versionKey.isFailure()) return failure(versionKey.value)

    /*
     * The script assembles the physical key server-side, so nothing here would otherwise
     * validate the caller's key. Building one under a throwaway version and discarding it keeps
     * `InvalidCacheKeyError` coming from the same place in both modes, instead of letting a key
     * with a colon in it reach Valkey and silently address a different slot.
     */
    const validated = this.keyBuilder.build({ key: input.key, namespace: input.namespace, version: 1 })
    if (validated.isFailure()) return failure(validated.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const namespacePrefix = `${this.prefix}:${input.namespace}`
    const physicalVersionKey: string = versionKey.value.physicalKey
    const logicalKey: string = input.key

    const replied = await this.executor.run({
      command: () =>
        connection.eval_ro(
          GET_WITH_NAMESPACE_VERSION_SCRIPT.source,
          GET_WITH_NAMESPACE_VERSION_SCRIPT.numberOfKeys,
          physicalVersionKey,
          namespacePrefix,
          logicalKey
        ),
      operation: 'get'
    })
    if (replied.isFailure()) return failure(replied.value)

    const reply: readonly string[] = toStringArray({ value: replied.value })
    this.refreshMemo({ namespace: input.namespace, raw: reply[0] })

    const raw: string | undefined = reply[1]
    if (raw === undefined) return success(MISS)

    return this.decode<T>({ raw, validate: input.validate })
  }

  /*
   * A strong read just came back from the master carrying a version nobody else has yet. Handing
   * it to the memo is free — the round trip is already paid for — and every eventual read that
   * follows skips the hop it would otherwise take to learn the same number.
   */
  private refreshMemo(input: { namespace: string; raw: string | undefined }): void {
    if (input.raw === undefined) return

    const version = Number(input.raw)
    if (!Number.isSafeInteger(version) || version < 1) return

    this.versions.applyBroadcast({ namespace: input.namespace, version })
  }

  /*
   * A corrupt payload is a miss, not an outage: the loader refills the key and the next write
   * overwrites it. Unlike the memory driver this does not delete the entry — a read path that
   * issues a write would need the master, which is the one connection eventual reads exist to
   * stay off.
   */
  private decode<T>(input: { raw: string; validate?: (value: unknown) => boolean }): ReadOutput<T> {
    const deserialized = this.serializer.deserialize<T>({ raw: input.raw })
    if (deserialized.isFailure()) return success(MISS)

    if (input.validate !== undefined && !input.validate(deserialized.value.value)) return success(MISS)

    return success({ found: true, value: deserialized.value.value })
  }
}
```

Dois pontos merecem leitura atenta.

**A leitura forte valida a chave com um `build` descartado.** O script monta a chave fisica no servidor, entao nada no lado TypeScript olharia para `input.key`. Construir uma sob uma versao de mentira e jogar fora mantem o `InvalidCacheKeyError` saindo do mesmo lugar nos dois modos, em vez de deixar uma chave com dois-pontos chegar no Valkey e enderecar outro slot em silencio.

**A leitura forte alimenta o memo.** O round-trip ja foi pago e a resposta traz uma versao fresca do master; entregar isso ao `applyBroadcast` faz as leituras eventuais seguintes pularem o hop que gastariam para aprender o mesmo numero. `applyBroadcast` so avanca, entao reaplicar a versao corrente e inofensivo.

Ao contrario do driver `memory`, um payload corrompido **nao** e apagado aqui. Deletar seria uma escrita no caminho de leitura, e escrita exige o master — justamente a conexao de que a leitura eventual existe para se afastar. A proxima escrita sobrescreve a chave de qualquer forma.

- [ ] **Step 6: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos tres, incluindo os testes do driver `memory`.

- [ ] **Step 7: Commit**

```bash
git add packages/cache/src/infra
git commit -m "feat(cache): share ttl jitter and add valkey key-value operations"
```

---

### Task 8: Operacoes de contador

**Files:**

- Create: `packages/cache/src/infra/drivers/valkey/operations/counter.operations.ts`

**Interfaces:**

- Consumes: `PhysicalKeyResolver`, `ValkeyConnectionManager`, `ValkeyCommandExecutor`.
- Produces: `CounterOperations` com `increment`, `decrement`, `getCounter`.

Contadores vao ao master **inclusive na leitura** (spec §8.1), diferente do `get` comum. O caso de uso e rate limiting, e uma replica com lag devolve uma contagem menor que a real — o que deixa passar requisicao acima do limite. Cache velho custa um miss; contador de rate limit velho custa a garantia.

- [ ] **Step 1: Implementar**

```ts
// packages/cache/src/infra/drivers/valkey/operations/counter.operations.ts
import { failure, success } from '@ruguin/utils'

import {
  type DecrementCounterProviderDTO,
  type GetCounterProviderDTO,
  type IncrementCounterProviderDTO
} from '../../../../domain'
import { type ValkeyConnectionManager } from '../connection/valkey-connection.manager'
import { type PhysicalKeyResolver } from '../physical-key.resolver'
import { type ValkeyCommandExecutor } from '../valkey-command.executor'

/*
 * Counters go to the master on reads too, unlike `get`. The use case is rate limiting, and a
 * replica running behind answers with a count lower than the truth — which lets traffic through
 * above the limit. A stale cached value costs a miss; a stale counter costs the guarantee.
 */
export class CounterOperations {
  private readonly connections: ValkeyConnectionManager
  private readonly executor: ValkeyCommandExecutor
  private readonly keys: PhysicalKeyResolver

  constructor(input: {
    connections: ValkeyConnectionManager
    executor: ValkeyCommandExecutor
    keys: PhysicalKeyResolver
  }) {
    this.connections = input.connections
    this.executor = input.executor
    this.keys = input.keys
  }

  public async increment(input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output {
    const key = await this.keys.physicalKey(input)
    if (key.isFailure()) return failure(key.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const physicalKey: string = key.value
    const by: number = input.by ?? 1

    const next = await this.executor.run({
      command: () => connection.incrby(physicalKey, by),
      operation: 'increment'
    })
    if (next.isFailure()) return failure(next.value)

    const windowInMs: number | undefined = input.windowInMs

    if (windowInMs !== undefined) {
      /*
       * NX, so the window is anchored to the first increment. A bare PEXPIRE would push the
       * expiry out on every call, and a fixed-window limiter whose window never closes under
       * sustained traffic is a limit that latches shut forever.
       */
      const windowed = await this.executor.run({
        command: () => connection.pexpire(physicalKey, windowInMs, 'NX'),
        operation: 'increment'
      })
      if (windowed.isFailure()) return failure(windowed.value)
    }

    return success({ value: next.value })
  }

  public async decrement(input: DecrementCounterProviderDTO.Input): DecrementCounterProviderDTO.Output {
    const key = await this.keys.physicalKey(input)
    if (key.isFailure()) return failure(key.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const physicalKey: string = key.value
    const by: number = input.by ?? 1

    const next = await this.executor.run({
      command: () => connection.decrby(physicalKey, by),
      operation: 'decrement'
    })
    if (next.isFailure()) return failure(next.value)

    return success({ value: next.value })
  }

  public async getCounter(input: GetCounterProviderDTO.Input): GetCounterProviderDTO.Output {
    const key = await this.keys.physicalKey(input)
    if (key.isFailure()) return failure(key.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const physicalKey: string = key.value

    const raw = await this.executor.run({
      command: () => connection.get(physicalKey),
      operation: 'getCounter'
    })
    if (raw.isFailure()) return failure(raw.value)

    /*
     * Absent counts as zero: "never incremented" and "counted down to nothing" are the same
     * answer to a rate limiter, and a null would make every call site handle a case it cannot act on.
     */
    if (raw.value === null) return success({ value: 0 })

    const parsed = Number(raw.value)

    return success({ value: Number.isFinite(parsed) ? parsed : 0 })
  }
}
```

`PEXPIRE ... NX` e o que ancora a janela no primeiro incremento. Um `PEXPIRE` simples empurraria a expiracao a cada chamada, e um limitador de janela fixa cuja janela nunca fecha sob trafego continuo e um limite que trava para sempre. O `windowInMs` e copiado para uma const local antes do closure porque o TypeScript nao preserva o estreitamento de uma propriedade dentro de callback — a const preserva.

- [ ] **Step 2: Rodar e confirmar que compila**

Run: `pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos dois. O comportamento e provado pela Task 17, que mede a janela contra um relogio real.

- [ ] **Step 3: Commit**

```bash
git add packages/cache/src/infra/drivers/valkey
git commit -m "feat(cache): add valkey counter operations with a fixed window"
```

---

### Task 9: Operacoes de lock

**Files:**

- Create: `packages/cache/src/infra/drivers/valkey/operations/lock.operations.ts`

**Interfaces:**

- Consumes: `KeyBuilder`, `ValkeyConnectionManager`, `ValkeyCommandExecutor`, `RELEASE_LOCK_SCRIPT`, `EXTEND_LOCK_SCRIPT`.
- Produces: `LockOperations` com `acquire`, `release`, `extend`.

- [ ] **Step 1: Implementar**

```ts
// packages/cache/src/infra/drivers/valkey/operations/lock.operations.ts
import { failure, success } from '@ruguin/utils'

import {
  type AcquireLockProviderDTO,
  type ExtendLockProviderDTO,
  LockNotAcquiredError,
  LockNotOwnedError,
  type ReleaseLockProviderDTO
} from '../../../../domain'
import { type KeyBuilder } from '../../../key-builder'
import { type ValkeyConnectionManager } from '../connection/valkey-connection.manager'
import { EXTEND_LOCK_SCRIPT, RELEASE_LOCK_SCRIPT } from '../scripts/lua-scripts'
import { type ValkeyCommandExecutor } from '../valkey-command.executor'

// Floor for a caller-supplied poll interval. See AcquireLockProviderDTO.Wait.
const MIN_POLL_INTERVAL_MS = 1

const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const isTruthyReply = (input: { value: unknown }): boolean => typeof input.value === 'number' && input.value > 0

/*
 * Locks never touch a replica, in either direction. Acquiring one off a node with replication
 * lag would rebuild the exact race the lock exists to close: two callers reading "free" from a
 * stale copy and both writing.
 */
export class LockOperations {
  private readonly connections: ValkeyConnectionManager
  private readonly executor: ValkeyCommandExecutor
  private readonly keyBuilder: KeyBuilder

  constructor(input: {
    connections: ValkeyConnectionManager
    executor: ValkeyCommandExecutor
    keyBuilder: KeyBuilder
  }) {
    this.connections = input.connections
    this.executor = input.executor
    this.keyBuilder = input.keyBuilder
  }

  public async acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    const key = this.keyBuilder.buildLockKey({ key: input.key, namespace: input.namespace })
    if (key.isFailure()) return failure(key.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const lockKey: string = key.value.physicalKey
    const token: string = crypto.randomUUID()
    const ttlInMs: number = input.ttlInMs

    /*
     * The budget is anchored once, at entry, and spent against the clock. Turning it into
     * `ceil(timeout / poll)` attempts would overshoot by the cost of the attempts themselves —
     * and against a network driver each attempt is a round trip, so a caller asking for 3s would
     * wait longest exactly when the cache is degraded and the round trips are slowest.
     */
    const deadlineAt: number = Date.now() + (input.wait?.timeoutInMs ?? 0)
    const pollIntervalInMs: number = Math.max(MIN_POLL_INTERVAL_MS, input.wait?.pollIntervalInMs ?? 0)

    let attempts = 0

    for (;;) {
      attempts += 1

      const stored = await this.executor.run({
        command: () => connection.set(lockKey, token, 'PX', ttlInMs, 'NX'),
        operation: 'acquire'
      })
      if (stored.isFailure()) return failure(stored.value)
      if (stored.value === 'OK') return success({ expiresAt: new Date(Date.now() + ttlInMs), token })

      const remainingInMs: number = deadlineAt - Date.now()
      if (remainingInMs <= 0) break

      // Capped by whatever is left, so the last attempt lands on the deadline rather than past it.
      await sleep(Math.min(pollIntervalInMs, remainingInMs))
    }

    return failure(new LockNotAcquiredError({ attempts, lockKey }))
  }

  public async release(input: ReleaseLockProviderDTO.Input): ReleaseLockProviderDTO.Output {
    const key = this.keyBuilder.buildLockKey({ key: input.key, namespace: input.namespace })
    if (key.isFailure()) return failure(key.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const lockKey: string = key.value.physicalKey
    const token: string = input.token

    const released = await this.executor.run({
      command: () => connection.eval(RELEASE_LOCK_SCRIPT.source, RELEASE_LOCK_SCRIPT.numberOfKeys, lockKey, token),
      operation: 'release'
    })
    if (released.isFailure()) return failure(released.value)

    // Zero means the token no longer matches: the lock expired and someone else took it.
    if (!isTruthyReply({ value: released.value })) return failure(new LockNotOwnedError({ lockKey }))

    return success({ released: true })
  }

  public async extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output {
    const key = this.keyBuilder.buildLockKey({ key: input.key, namespace: input.namespace })
    if (key.isFailure()) return failure(key.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const lockKey: string = key.value.physicalKey
    const token: string = input.token
    const ttlInMs: number = input.ttlInMs

    const extended = await this.executor.run({
      command: () =>
        connection.eval(EXTEND_LOCK_SCRIPT.source, EXTEND_LOCK_SCRIPT.numberOfKeys, lockKey, token, ttlInMs),
      operation: 'extend'
    })
    if (extended.isFailure()) return failure(extended.value)

    if (!isTruthyReply({ value: extended.value })) return failure(new LockNotOwnedError({ lockKey }))

    return success({ expiresAt: new Date(Date.now() + ttlInMs) })
  }
}
```

O orcamento de espera e ancorado uma vez, na entrada, e gasto contra o relogio. Converte-lo em `ceil(timeout / poll)` tentativas estouraria o prazo pelo custo das proprias tentativas — e contra um driver de rede cada tentativa e um round-trip, de modo que quem pediu 3s esperaria mais justamente quando o cache esta degradado.

O compare-and-swap dos dois scripts e o que impede um processo lento, cujo lock ja expirou, de liberar (ou estender) o lock que **outro** processo adquiriu depois. Um `DEL` cego ali daria dois donos ao mesmo lock, sem erro em lugar nenhum.

- [ ] **Step 2: Rodar e confirmar que compila**

Run: `pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos dois.

- [ ] **Step 3: Commit**

```bash
git add packages/cache/src/infra/drivers/valkey
git commit -m "feat(cache): add valkey lock operations with token compare-and-swap"
```

---

### Task 10: Operacoes de score

**Files:**

- Create: `packages/cache/src/infra/drivers/valkey/operations/score.operations.ts`

**Interfaces:**

- Consumes: `PhysicalKeyResolver`, `ValkeyConnectionManager`, `ValkeyCommandExecutor`.
- Produces: `ScoreOperations` com `setScore`, `incrementScore`, `getScore`, `getRank`, `getTopScores`, `removeScore`, `countScores`.

- [ ] **Step 1: Implementar**

```ts
// packages/cache/src/infra/drivers/valkey/operations/score.operations.ts
import { type Either, failure, success } from '@ruguin/utils'
import { type Redis } from 'iovalkey'

import {
  CacheConsistency,
  type CacheNotInitializedError,
  type CacheOperationError,
  type CountScoresProviderDTO,
  type GetRankProviderDTO,
  type GetScoreProviderDTO,
  type GetTopScoresProviderDTO,
  type IncrementScoreProviderDTO,
  type RemoveScoreProviderDTO,
  type SetScoreProviderDTO
} from '../../../../domain'
import { type ValkeyConnectionManager } from '../connection/valkey-connection.manager'
import { type PhysicalKeyResolver } from '../physical-key.resolver'
import { type ValkeyCommandExecutor } from '../valkey-command.executor'

type PipelineReply = Array<[error: Error | null, result: unknown]> | null

type ReadTarget = Readonly<{ connection: Redis; physicalKey: string }>

type ReadTargetOutput = Promise<Either<CacheOperationError, ReadTarget>>

const toNumberOrNull = (input: { value: string | null }): number | null => {
  if (input.value === null) return null

  const parsed = Number(input.value)

  return Number.isFinite(parsed) ? parsed : null
}

/*
 * A per-command error inside a pipeline means the key holds something that is not a sorted set.
 * On a read that is the fail-open answer — "not ranked" — rather than an outage: the caller
 * still gets a usable pair and the loader remains the source of truth.
 */
const pipelineSlot = (input: { index: number; results: PipelineReply }): unknown => {
  const entry: [error: Error | null, result: unknown] | undefined = input.results?.[input.index]
  if (entry === undefined) return null

  const [error, value] = entry

  return error === null ? value : null
}

// ZREVRANGE ... WITHSCORES answers one flat list: member, score, member, score.
const pairsOf = (input: { flat: readonly string[] }): readonly GetTopScoresProviderDTO.Entry[] => {
  const entries: GetTopScoresProviderDTO.Entry[] = []

  for (let index = 0; index + 1 < input.flat.length; index += 2) {
    const member: string | undefined = input.flat[index]
    const score: string | undefined = input.flat[index + 1]
    if (member === undefined || score === undefined) continue

    entries.push({ member, score: toNumberOrNull({ value: score }) ?? 0 })
  }

  return entries
}

export class ScoreOperations {
  private readonly connections: ValkeyConnectionManager
  private readonly executor: ValkeyCommandExecutor
  private readonly keys: PhysicalKeyResolver

  constructor(input: {
    connections: ValkeyConnectionManager
    executor: ValkeyCommandExecutor
    keys: PhysicalKeyResolver
  }) {
    this.connections = input.connections
    this.executor = input.executor
    this.keys = input.keys
  }

  public async setScore(input: SetScoreProviderDTO.Input): SetScoreProviderDTO.Output {
    const target = await this.writeTarget(input)
    if (target.isFailure()) return failure(target.value)

    const { connection, physicalKey } = target.value
    const member: string = input.member
    const score: number = input.score

    const added = await this.executor.run({
      command: () => connection.zadd(physicalKey, score, member),
      operation: 'setScore'
    })
    if (added.isFailure()) return failure(added.value)

    const expired = await this.expire({ connection, physicalKey, ttlInMs: input.ttlInMs })
    if (expired !== null) return failure(expired)

    return success({ created: added.value > 0 })
  }

  public async incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output {
    const target = await this.writeTarget(input)
    if (target.isFailure()) return failure(target.value)

    const { connection, physicalKey } = target.value
    const member: string = input.member
    const by: number = input.by

    const next = await this.executor.run({
      command: () => connection.zincrby(physicalKey, by, member),
      operation: 'incrementScore'
    })
    if (next.isFailure()) return failure(next.value)

    const expired = await this.expire({ connection, physicalKey, ttlInMs: input.ttlInMs })
    if (expired !== null) return failure(expired)

    return success({ score: toNumberOrNull({ value: next.value }) ?? 0 })
  }

  public async getScore(input: GetScoreProviderDTO.Input): GetScoreProviderDTO.Output {
    const target = await this.readTarget(input)
    if (target.isFailure()) return failure(target.value)

    const { connection, physicalKey } = target.value
    const member: string = input.member

    const raw = await this.executor.run({
      command: () => connection.zscore(physicalKey, member),
      operation: 'getScore'
    })
    if (raw.isFailure()) return failure(raw.value)

    return success({ score: toNumberOrNull({ value: raw.value }) })
  }

  public async getRank(input: GetRankProviderDTO.Input): GetRankProviderDTO.Output {
    const target = await this.readTarget(input)
    if (target.isFailure()) return failure(target.value)

    const { connection, physicalKey } = target.value
    const member: string = input.member

    /*
     * Rank and size in one pipeline. A position on its own is rarely what an interface renders —
     * "12th of 340" is — and two separate round trips could straddle a write, reporting a rank
     * against a different total than the one it was computed in.
     */
    const replied = await this.executor.run({
      command: () => connection.pipeline().zrevrank(physicalKey, member).zcard(physicalKey).exec(),
      operation: 'getRank'
    })
    if (replied.isFailure()) return failure(replied.value)

    const rawRank: unknown = pipelineSlot({ index: 0, results: replied.value })
    const rawTotal: unknown = pipelineSlot({ index: 1, results: replied.value })

    // ZREVRANK is zero-based; the contract is one-based, because "0th of 340" reads as an error.
    return success({
      rank: typeof rawRank === 'number' ? rawRank + 1 : null,
      total: typeof rawTotal === 'number' ? rawTotal : 0
    })
  }

  public async getTopScores(input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output {
    const target = await this.readTarget(input)
    if (target.isFailure()) return failure(target.value)

    const { connection, physicalKey } = target.value
    const offset: number = input.offset ?? 0
    const stop: number = offset + input.limit - 1

    const flat = await this.executor.run({
      command: () => connection.zrevrange(physicalKey, offset, stop, 'WITHSCORES'),
      operation: 'getTopScores'
    })
    if (flat.isFailure()) return failure(flat.value)

    return success({ entries: pairsOf({ flat: flat.value }) })
  }

  public async removeScore(input: RemoveScoreProviderDTO.Input): RemoveScoreProviderDTO.Output {
    const target = await this.writeTarget(input)
    if (target.isFailure()) return failure(target.value)

    const { connection, physicalKey } = target.value
    const member: string = input.member

    const removed = await this.executor.run({
      command: () => connection.zrem(physicalKey, member),
      operation: 'removeScore'
    })
    if (removed.isFailure()) return failure(removed.value)

    return success({ removed: removed.value > 0 })
  }

  public async countScores(input: CountScoresProviderDTO.Input): CountScoresProviderDTO.Output {
    const target = await this.readTarget(input)
    if (target.isFailure()) return failure(target.value)

    const { connection, physicalKey } = target.value

    const total = await this.executor.run({
      command: () => connection.zcard(physicalKey),
      operation: 'countScores'
    })
    if (total.isFailure()) return failure(total.value)

    return success({ total: total.value })
  }

  private async expire(input: {
    connection: Redis
    physicalKey: string
    ttlInMs: number | undefined
  }): Promise<CacheOperationError | null> {
    const ttlInMs: number | undefined = input.ttlInMs
    if (ttlInMs === undefined) return null

    const connection: Redis = input.connection
    const physicalKey: string = input.physicalKey

    // Sorted sets have no per-member TTL, so the expiry covers the whole set (spec §5.5).
    const expired = await this.executor.run({
      command: () => connection.pexpire(physicalKey, ttlInMs),
      operation: 'expireScores'
    })

    return expired.isFailure() ? expired.value : null
  }

  private async writeTarget(input: { key: string; namespace: string }): ReadTargetOutput {
    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const key = await this.keys.physicalKey(input)
    if (key.isFailure()) return failure(key.value)

    return success({ connection: master.value, physicalKey: key.value })
  }

  /*
   * The consistency cascade picks both the node the version comes from and the node the command
   * runs on. Splitting them would let a strong read resolve a fresh version on the master and
   * then look it up on a replica that has not received the write yet — the stale answer the mode
   * is bought to rule out.
   */
  private async readTarget(input: {
    consistency?: CacheConsistency
    key: string
    namespace: string
  }): ReadTargetOutput {
    const consistency: CacheConsistency = this.keys.consistencyFor(input)
    const client: Either<CacheNotInitializedError, Redis> =
      consistency === CacheConsistency.STRONG ? this.connections.master() : this.connections.reader()
    if (client.isFailure()) return failure(client.value)

    const key = await this.keys.physicalKey({ ...input, consistency })
    if (key.isFailure()) return failure(key.value)

    return success({ connection: client.value, physicalKey: key.value })
  }
}
```

`readTarget` resolve a consistencia **uma vez** e usa o resultado para as duas decisoes: de qual no vem a versao e em qual no o comando roda. Separar as duas deixaria uma leitura forte resolver a versao no master e depois consultar uma replica que ainda nao recebeu a escrita — de novo o dado velho que o modo forte e comprado para eliminar.

`ZREVRANK` e zero-based e o contrato e one-based, porque "0º de 340" se le como erro.

- [ ] **Step 2: Rodar e confirmar que compila**

Run: `pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos dois.

- [ ] **Step 3: Commit**

```bash
git add packages/cache/src/infra/drivers/valkey
git commit -m "feat(cache): add valkey sorted set operations"
```

---

### Task 11: Parser do INFO e health check

**Files:**

- Create: `packages/cache/src/infra/drivers/valkey/operations/valkey-info.parser.ts`
- Create: `packages/cache/src/infra/drivers/valkey/operations/health.operations.ts`
- Test: `packages/cache/src/infra/drivers/valkey/operations/__tests__/valkey-info.parser.unit.ts`

**Interfaces:**

- Consumes: `ValkeyConnectionManager`, `ValkeyCommandExecutor`, `CacheHealthStatus`, `HealthCheckProviderDTO`.
- Produces: `ValkeyInfo`, `parseValkeyInfo`, `infoNumber`, `infoText`, `memoryHealthFrom`, `clientsHealthFrom`, `serverInfoFrom`, `replicationLagFrom`, `deriveHealthStatus`; `HealthOperations.check(input?)`.

Toda a derivacao e pura e fica no parser, justamente para ser testavel a partir de um payload de `INFO` colado num teste. A classe so faz PING, INFO e montagem.

As secoes pedidas sao cinco, e nao quatro: `evicted_keys` e `rejected_connections` vivem em `stats`, nao em `memory`/`clients`. Sao os dois sinais que anunciam problema antes de qualquer erro aparecer — eviccao destroi o hit rate em silencio, e conexao recusada se manifesta como timeout intermitente que depois some.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// packages/cache/src/infra/drivers/valkey/operations/__tests__/valkey-info.parser.unit.ts
import { describe, expect, it } from 'vitest'

import { CacheHealthStatus, type HealthCheckProviderDTO } from '../../../../../domain'
import {
  clientsHealthFrom,
  deriveHealthStatus,
  memoryHealthFrom,
  parseValkeyInfo,
  replicationLagFrom,
  serverInfoFrom
} from '../valkey-info.parser'

const MASTER_INFO = [
  '# Server',
  'redis_version:7.2.4',
  'uptime_in_seconds:4211',
  '',
  '# Clients',
  'connected_clients:6',
  'blocked_clients:0',
  '',
  '# Memory',
  'used_memory:1048576',
  'maxmemory:0',
  '',
  '# Stats',
  'evicted_keys:0',
  'rejected_connections:0',
  '',
  '# Replication',
  'role:master',
  'connected_slaves:1',
  'master_repl_offset:5000',
  'slave0:ip=172.18.0.4,port=6379,state=online,offset=4998,lag=0'
].join('\r\n')

const replicaHealth = (
  overrides: Partial<HealthCheckProviderDTO.ReplicaHealth>
): HealthCheckProviderDTO.ReplicaHealth => ({
  host: 'localhost:6380',
  latencyInMs: 1,
  reachable: true,
  replicationLagInBytes: 0,
  ...overrides
})

const memoryHealth = (
  overrides: Partial<HealthCheckProviderDTO.MemoryHealth>
): HealthCheckProviderDTO.MemoryHealth => ({
  evictedKeys: 0,
  maxBytes: null,
  usedBytes: 1024,
  usedPercentage: null,
  ...overrides
})

describe('parseValkeyInfo', () => {
  it('reads fields across every requested section, ignoring headers and CRLF', () => {
    const info = parseValkeyInfo({ raw: MASTER_INFO })

    expect(info.get('redis_version')).toBe('7.2.4')
    expect(info.get('connected_clients')).toBe('6')
    expect(info.get('evicted_keys')).toBe('0')
    expect(info.get('role')).toBe('master')
  })

  // A slaveN line's value is itself full of colons; splitting on the first one keeps it intact.
  it('keeps everything after the first colon as the value', () => {
    const info = parseValkeyInfo({ raw: MASTER_INFO })

    expect(info.get('slave0')).toBe('ip=172.18.0.4,port=6379,state=online,offset=4998,lag=0')
  })
})

describe('memoryHealthFrom', () => {
  /*
   * maxmemory:0 means unlimited, which is the local default. A percentage of an unbounded budget
   * has no meaning, so it must be null — a 0 would read as "plenty of room" and quietly disarm
   * the pressure check on exactly the instances that never trip it.
   */
  it('reports no percentage when maxmemory is unlimited', () => {
    const memory = memoryHealthFrom({ info: parseValkeyInfo({ raw: MASTER_INFO }) })

    expect(memory).toEqual({ evictedKeys: 0, maxBytes: null, usedBytes: 1_048_576, usedPercentage: null })
  })

  it('computes the percentage once maxmemory is set', () => {
    const info = parseValkeyInfo({ raw: 'used_memory:900\nmaxmemory:1000\nevicted_keys:3' })

    expect(memoryHealthFrom({ info })).toEqual({
      evictedKeys: 3,
      maxBytes: 1000,
      usedBytes: 900,
      usedPercentage: 90
    })
  })
})

describe('clientsHealthFrom and serverInfoFrom', () => {
  it('reads the client counters, defaulting a missing rejected_connections to zero', () => {
    const info = parseValkeyInfo({ raw: 'connected_clients:6\nblocked_clients:2' })

    expect(clientsHealthFrom({ info })).toEqual({ blocked: 2, connected: 6, rejectedTotal: 0 })
  })

  it('reads the server identity', () => {
    const info = parseValkeyInfo({ raw: MASTER_INFO })

    expect(serverInfoFrom({ info })).toEqual({ uptimeInSeconds: 4211, version: '7.2.4' })
  })
})

describe('replicationLagFrom', () => {
  it('measures how many bytes the replica still has to replay', () => {
    const master = parseValkeyInfo({ raw: 'master_repl_offset:5000' })
    const replica = parseValkeyInfo({ raw: 'slave_repl_offset:4900' })

    expect(replicationLagFrom({ master, replica })).toBe(100)
  })

  /*
   * Null, never 0. "Unknown lag" and "no lag" have to stay distinct — collapsing them would let a
   * replica with a missing offset field read as perfectly synchronised.
   */
  it('answers null when either side did not report an offset', () => {
    const master = parseValkeyInfo({ raw: 'master_repl_offset:5000' })

    expect(replicationLagFrom({ master, replica: parseValkeyInfo({ raw: 'role:slave' }) })).toBeNull()
  })

  it('never reports negative lag when the replica reads ahead of the sampled master offset', () => {
    const master = parseValkeyInfo({ raw: 'master_repl_offset:4900' })
    const replica = parseValkeyInfo({ raw: 'slave_repl_offset:5000' })

    expect(replicationLagFrom({ master, replica })).toBe(0)
  })
})

describe('deriveHealthStatus', () => {
  it('is healthy when the master answers and nothing is behind', () => {
    expect(
      deriveHealthStatus({
        masterReachable: true,
        memory: memoryHealth({}),
        replicas: [replicaHealth({})],
        replicationLagThresholdInBytes: 1_048_576
      })
    ).toBe(CacheHealthStatus.HEALTHY)
  })

  it('is unhealthy only when the master itself is gone', () => {
    expect(
      deriveHealthStatus({
        masterReachable: false,
        memory: memoryHealth({}),
        replicas: [],
        replicationLagThresholdInBytes: 1_048_576
      })
    ).toBe(CacheHealthStatus.UNHEALTHY)
  })

  /*
   * Degraded, not unhealthy: reads fall back to the master and the application keeps working.
   * Marking this down would pull the instance out of the load balancer and turn a degradation
   * into an outage.
   */
  it('is degraded when a replica is unreachable', () => {
    expect(
      deriveHealthStatus({
        masterReachable: true,
        memory: memoryHealth({}),
        replicas: [replicaHealth({ reachable: false })],
        replicationLagThresholdInBytes: 1_048_576
      })
    ).toBe(CacheHealthStatus.DEGRADED)
  })

  it('is degraded when a replica lags past the threshold', () => {
    expect(
      deriveHealthStatus({
        masterReachable: true,
        memory: memoryHealth({}),
        replicas: [replicaHealth({ replicationLagInBytes: 2_000_000 })],
        replicationLagThresholdInBytes: 1_048_576
      })
    ).toBe(CacheHealthStatus.DEGRADED)
  })

  it('is degraded at 90% of maxmemory, before eviction starts destroying the hit rate', () => {
    expect(
      deriveHealthStatus({
        masterReachable: true,
        memory: memoryHealth({ maxBytes: 1000, usedBytes: 900, usedPercentage: 90 }),
        replicas: [],
        replicationLagThresholdInBytes: 1_048_576
      })
    ).toBe(CacheHealthStatus.DEGRADED)
  })

  it('does not read an unlimited maxmemory as memory pressure', () => {
    expect(
      deriveHealthStatus({
        masterReachable: true,
        memory: memoryHealth({ usedBytes: 9_000_000_000 }),
        replicas: [],
        replicationLagThresholdInBytes: 1_048_576
      })
    ).toBe(CacheHealthStatus.HEALTHY)
  })
})
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../valkey-info.parser'`.

- [ ] **Step 3: Implementar o parser**

```ts
// packages/cache/src/infra/drivers/valkey/operations/valkey-info.parser.ts
import { CacheHealthStatus, type HealthCheckProviderDTO } from '../../../../domain'

export type ValkeyInfo = ReadonlyMap<string, string>

/*
 * Anything at or above this share of `maxmemory` is reported as degraded. It is deliberately
 * below 100: by the time eviction starts the hit rate has already collapsed, and nothing in the
 * error path says so — `evicted_keys` climbing is the only symptom, and it is silent.
 */
const MEMORY_PRESSURE_PERCENTAGE = 90

/*
 * INFO answers `field:value` lines grouped under `# Section` headers, with CRLF endings. Parsed
 * into a flat map because the field names are already unique across the sections we ask for.
 */
export const parseValkeyInfo = (input: { raw: string }): ValkeyInfo => {
  const parsed = new Map<string, string>()

  for (const line of input.raw.split('\n')) {
    const trimmed: string = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue

    const separatorAt: number = trimmed.indexOf(':')
    if (separatorAt === -1) continue

    parsed.set(trimmed.slice(0, separatorAt), trimmed.slice(separatorAt + 1))
  }

  return parsed
}

export const infoNumber = (input: { fallback: number; field: string; info: ValkeyInfo }): number => {
  const raw: string | undefined = input.info.get(input.field)
  if (raw === undefined) return input.fallback

  const parsed = Number(raw)

  return Number.isFinite(parsed) ? parsed : input.fallback
}

export const infoText = (input: { fallback: string; field: string; info: ValkeyInfo }): string =>
  input.info.get(input.field) ?? input.fallback

export const memoryHealthFrom = (input: { info: ValkeyInfo }): HealthCheckProviderDTO.MemoryHealth => {
  const usedBytes: number = infoNumber({ fallback: 0, field: 'used_memory', info: input.info })
  const configured: number = infoNumber({ fallback: 0, field: 'maxmemory', info: input.info })

  /*
   * `maxmemory:0` means unlimited, not "zero bytes available". A percentage of an unbounded
   * budget has no meaning, so it is null rather than 0 — a 0 would read as "plenty of room" and
   * silence the pressure check on exactly the instances that never trip it.
   */
  const maxBytes: number | null = configured > 0 ? configured : null

  return {
    evictedKeys: infoNumber({ fallback: 0, field: 'evicted_keys', info: input.info }),
    maxBytes,
    usedBytes,
    usedPercentage: maxBytes === null ? null : (usedBytes / maxBytes) * 100
  }
}

export const clientsHealthFrom = (input: { info: ValkeyInfo }): HealthCheckProviderDTO.ClientsHealth => ({
  blocked: infoNumber({ fallback: 0, field: 'blocked_clients', info: input.info }),
  connected: infoNumber({ fallback: 0, field: 'connected_clients', info: input.info }),
  rejectedTotal: infoNumber({ fallback: 0, field: 'rejected_connections', info: input.info })
})

export const serverInfoFrom = (input: { info: ValkeyInfo }): HealthCheckProviderDTO.ServerInfo => ({
  uptimeInSeconds: infoNumber({ fallback: 0, field: 'uptime_in_seconds', info: input.info }),
  version: infoText({ fallback: 'unknown', field: 'redis_version', info: input.info })
})

/*
 * Bytes the replica still has to replay: how far its stream offset trails the master's. Null
 * when either side did not report an offset, because "unknown lag" and "no lag" must not be the
 * same value — a missing field would otherwise read as a perfectly synchronised replica.
 */
export const replicationLagFrom = (input: { master: ValkeyInfo; replica: ValkeyInfo }): number | null => {
  const masterOffset: string | undefined = input.master.get('master_repl_offset')
  const replicaOffset: string | undefined = input.replica.get('slave_repl_offset')
  if (masterOffset === undefined || replicaOffset === undefined) return null

  const ahead = Number(masterOffset)
  const behind = Number(replicaOffset)
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null

  return Math.max(0, ahead - behind)
}

/*
 * "Not healthy" is not an error — it is the answer the caller asked for. Degraded in particular
 * has to stay distinct from unhealthy: pulling an instance out of the load balancer because one
 * replica fell behind turns a degradation into an outage.
 */
export const deriveHealthStatus = (input: {
  masterReachable: boolean
  memory: HealthCheckProviderDTO.MemoryHealth
  replicas: readonly HealthCheckProviderDTO.ReplicaHealth[]
  replicationLagThresholdInBytes: number
}): CacheHealthStatus => {
  if (!input.masterReachable) return CacheHealthStatus.UNHEALTHY

  const isMemoryPressured: boolean =
    input.memory.usedPercentage !== null && input.memory.usedPercentage >= MEMORY_PRESSURE_PERCENTAGE

  const isReplicaDegraded: boolean = input.replicas.some(
    (replica) =>
      !replica.reachable ||
      (replica.replicationLagInBytes !== null && replica.replicationLagInBytes > input.replicationLagThresholdInBytes)
  )

  return isMemoryPressured || isReplicaDegraded ? CacheHealthStatus.DEGRADED : CacheHealthStatus.HEALTHY
}
```

- [ ] **Step 4: Implementar o health check**

```ts
// packages/cache/src/infra/drivers/valkey/operations/health.operations.ts
import { failure, success } from '@ruguin/utils'
import { type Redis } from 'iovalkey'

import { CacheDriver, type HealthCheckProviderDTO } from '../../../../domain'
import { type ValkeyConnectionManager, type ValkeyReplica } from '../connection/valkey-connection.manager'
import { type ValkeyCommandExecutor } from '../valkey-command.executor'

import {
  clientsHealthFrom,
  deriveHealthStatus,
  infoText,
  memoryHealthFrom,
  parseValkeyInfo,
  replicationLagFrom,
  serverInfoFrom,
  type ValkeyInfo
} from './valkey-info.parser'

/*
 * `stats` carries `evicted_keys` and `rejected_connections`, which are the two signals that
 * announce trouble before anything starts erroring: eviction quietly destroys the hit rate, and
 * a rejected connection surfaces as an intermittent timeout that then disappears.
 */
const INFO_SECTIONS: readonly string[] = ['replication', 'memory', 'clients', 'server', 'stats']

type Probe = Readonly<{ error?: string; info: ValkeyInfo; latencyInMs: number; reachable: boolean }>

export class HealthOperations {
  private readonly connections: ValkeyConnectionManager
  private readonly executor: ValkeyCommandExecutor
  private readonly replicationLagThresholdInBytes: number

  constructor(input: {
    connections: ValkeyConnectionManager
    executor: ValkeyCommandExecutor
    replicationLagThresholdInBytes: number
  }) {
    this.connections = input.connections
    this.executor = input.executor
    this.replicationLagThresholdInBytes = input.replicationLagThresholdInBytes
  }

  public async check(input?: HealthCheckProviderDTO.Input): HealthCheckProviderDTO.Output {
    /*
     * The only failure this contract admits. An unreachable master is a *reported* status, not
     * an Either failure — the caller asked how the cache is doing and "it is down" answers that.
     * Calling before connect() is a programming error, and that is what fails.
     */
    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const timeoutInMs: number | undefined = input?.timeoutInMs
    const probe: Probe = await this.probe({ client: master.value, timeoutInMs })

    const replicas: readonly HealthCheckProviderDTO.ReplicaHealth[] =
      input?.includeReplicas === false ? [] : await this.probeReplicas({ master: probe.info, timeoutInMs })

    const memory: HealthCheckProviderDTO.MemoryHealth = memoryHealthFrom({ info: probe.info })

    return success({
      checkedAt: new Date(),
      clients: clientsHealthFrom({ info: probe.info }),
      driver: CacheDriver.VALKEY,
      master: {
        latencyInMs: probe.latencyInMs,
        reachable: probe.reachable,
        role: infoText({ fallback: 'unknown', field: 'role', info: probe.info }),
        ...(probe.error !== undefined && { error: probe.error })
      },
      memory,
      replicas,
      server: serverInfoFrom({ info: probe.info }),
      status: deriveHealthStatus({
        masterReachable: probe.reachable,
        memory,
        replicas,
        replicationLagThresholdInBytes: this.replicationLagThresholdInBytes
      })
    })
  }

  private async probeReplicas(input: {
    master: ValkeyInfo
    timeoutInMs: number | undefined
  }): Promise<readonly HealthCheckProviderDTO.ReplicaHealth[]> {
    const replicas: readonly ValkeyReplica[] = this.connections.replicas()

    return Promise.all(
      replicas.map(async (replica): Promise<HealthCheckProviderDTO.ReplicaHealth> => {
        const probe: Probe = await this.probe({ client: replica.client, timeoutInMs: input.timeoutInMs })

        return {
          host: replica.host,
          latencyInMs: probe.latencyInMs,
          reachable: probe.reachable,
          replicationLagInBytes: probe.reachable
            ? replicationLagFrom({ master: input.master, replica: probe.info })
            : null,
          ...(probe.error !== undefined && { error: probe.error })
        }
      })
    )
  }

  private async probe(input: { client: Redis; timeoutInMs: number | undefined }): Promise<Probe> {
    const client: Redis = input.client
    const budget: { timeoutInMs?: number } = input.timeoutInMs === undefined ? {} : { timeoutInMs: input.timeoutInMs }

    const startedAt: number = Date.now()

    const pong = await this.executor.run({ command: () => client.ping(), operation: 'healthCheck', ...budget })

    const latencyInMs: number = Date.now() - startedAt

    if (pong.isFailure()) {
      return { error: pong.value.message, info: new Map<string, string>(), latencyInMs, reachable: false }
    }

    const raw = await this.executor.run({
      command: () => client.info(...INFO_SECTIONS),
      operation: 'healthCheck',
      ...budget
    })

    /*
     * PING answered but INFO did not: the node is up, we just have no numbers for it. Reported
     * as reachable with an empty map so the status stays healthy on the strength of the PING,
     * while the missing detail is visible in `error`.
     */
    if (raw.isFailure()) {
      return { error: raw.value.message, info: new Map<string, string>(), latencyInMs, reachable: true }
    }

    return { info: parseValkeyInfo({ raw: raw.value }), latencyInMs, reachable: true }
  }
}
```

Um master inalcancavel **nao** e falha do `Either` — e o status reportado, porque "o cache caiu" e a resposta que o chamador pediu. `OutputError` fica reservado a `CacheNotInitializedError`, que e chamar antes do `connect()`: erro de programacao.

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos tres.

- [ ] **Step 6: Commit**

```bash
git add packages/cache/src/infra/drivers/valkey
git commit -m "feat(cache): add valkey info parsing and the health check operation"
```

---

### Task 12: Subscriber de invalidacao

**Files:**

- Create: `packages/cache/src/infra/drivers/valkey/invalidation/invalidation-subscriber.ts`

**Interfaces:**

- Consumes: `ValkeyConnectionManager`, `ValkeyCommandExecutor`, `NamespaceVersionResolver`, `OnCacheError`, `decodeInvalidation`, `invalidationChannelOf`.
- Produces: `InvalidationSubscriber.start(): Promise<Either<CacheConnectionError | CacheNotInitializedError | CacheTimeoutError, true>>`.

As quatro regras de correcao da spec §4.3 estao todas aqui ou logo ao lado:

| Regra                             | Onde                                                |
| --------------------------------- | --------------------------------------------------- |
| Conexao dedicada                  | `ValkeyConnectionManager.subscriber()` (Task 3)     |
| Reconexao descarta o memo inteiro | `client.on('ready', ...)` abaixo                    |
| Versao so avanca                  | `NamespaceVersionResolver.applyBroadcast` (plano 1) |
| Mensagem propria e idempotente    | consequencia da regra anterior                      |

- [ ] **Step 1: Implementar**

```ts
// packages/cache/src/infra/drivers/valkey/invalidation/invalidation-subscriber.ts
import { type Either, failure, success } from '@ruguin/utils'
import { type Redis } from 'iovalkey'

import { type OnCacheError } from '../../../../application/on-cache-error'
import { type CacheConnectionError, type CacheNotInitializedError, type CacheTimeoutError } from '../../../../domain'
import { type NamespaceVersionResolver } from '../../../namespace-version.resolver'
import { type ValkeyConnectionManager } from '../connection/valkey-connection.manager'
import { type ValkeyCommandExecutor } from '../valkey-command.executor'

import { decodeInvalidation, invalidationChannelOf, type InvalidationMessage } from './invalidation-publisher'

type StartOutput = Promise<Either<CacheConnectionError | CacheNotInitializedError | CacheTimeoutError, true>>

export class InvalidationSubscriber {
  private readonly channel: string
  private readonly connections: ValkeyConnectionManager
  private readonly executor: ValkeyCommandExecutor
  private readonly onCacheError: OnCacheError
  private readonly versions: NamespaceVersionResolver

  private started = false

  constructor(input: {
    connections: ValkeyConnectionManager
    executor: ValkeyCommandExecutor
    onCacheError: OnCacheError
    prefix: string
    versions: NamespaceVersionResolver
  }) {
    this.connections = input.connections
    this.executor = input.executor
    this.onCacheError = input.onCacheError
    this.versions = input.versions
    this.channel = invalidationChannelOf({ prefix: input.prefix })
  }

  public async start(): StartOutput {
    if (this.started) return success(true)

    const subscriber = this.connections.subscriber()
    if (subscriber.isFailure()) return failure(subscriber.value)

    const client: Redis = subscriber.value

    client.on('message', (channel: string, raw: string) => {
      this.apply({ channel, raw })
    })

    /*
     * Every `ready` drops the memo whole, not just the namespace the last message named. A
     * reconnect means messages may have been missed while the socket was down and there is no
     * record of which namespaces they carried, so the only safe assumption is that every
     * memoised version is suspect. The first `ready` fires against an empty memo, so this costs
     * nothing at startup.
     *
     * Re-subscribing is not done here: iovalkey replays the subscription itself on reconnect
     * (`autoResubscribe`, on by default), and issuing a second SUBSCRIBE would race that replay.
     */
    client.on('ready', () => {
      this.versions.clearMemo()
    })

    const channel: string = this.channel

    const subscribed = await this.executor.run({
      command: () => client.subscribe(channel),
      operation: 'subscribeInvalidation'
    })
    if (subscribed.isFailure()) return failure(subscribed.value)

    this.started = true

    return success(true)
  }

  private apply(input: { channel: string; raw: string }): void {
    if (input.channel !== this.channel) return

    const message: InvalidationMessage | null = decodeInvalidation({ raw: input.raw })

    if (message === null) {
      this.onCacheError({
        error: new Error(`unparseable invalidation payload: ${input.raw}`),
        key: input.channel,
        namespace: '',
        operation: 'applyInvalidation'
      })

      return
    }

    /*
     * Our own publish comes back to us as well. `applyBroadcast` only ever moves a version
     * forward, so re-applying the number we just wrote is a no-op — and the same guard is what
     * keeps a redelivered or out-of-order message from walking the memo backwards.
     */
    this.versions.applyBroadcast(message)
  }
}
```

Todo `ready` limpa o memo **inteiro**, nao so o namespace da ultima mensagem: uma reconexao pode ter perdido mensagens enquanto o socket esteve fora e nao ha registro de quais namespaces elas citavam. O primeiro `ready` acontece com o memo vazio, entao o custo no startup e zero.

Nao ha re-subscribe no `ready`: o `iovalkey` reenvia a assinatura sozinho na reconexao (`autoResubscribe`, ligado por default), e um `SUBSCRIBE` extra correria com esse replay.

- [ ] **Step 2: Rodar e confirmar que compila**

Run: `pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos dois. O comportamento e provado pelos tres cenarios de consistencia da Task 17.

- [ ] **Step 3: Commit**

```bash
git add packages/cache/src/infra/drivers/valkey
git commit -m "feat(cache): add the invalidation subscriber with memo reset on reconnect"
```

---

### Task 13: Driver Valkey

**Files:**

- Create: `packages/cache/src/infra/drivers/valkey/valkey-cache.driver.ts`
- Create: `packages/cache/src/infra/drivers/valkey/index.ts`
- Modify: `packages/cache/src/infra/drivers/index.ts`

**Interfaces:**

- Consumes: todas as operations, o `ValkeyConnectionManager`, o `InvalidationSubscriber`, o `NamespaceVersionResolver` e `OnCacheError`.
- Produces: `ValkeyCacheDriver implements ICacheDriver`.

- [ ] **Step 1: Implementar o driver**

```ts
// packages/cache/src/infra/drivers/valkey/valkey-cache.driver.ts
import { failure, success } from '@ruguin/utils'

import { type OnCacheError } from '../../../application/on-cache-error'
import {
  type AcquireLockProviderDTO,
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
import { type NamespaceVersionResolver } from '../../namespace-version.resolver'

import { type ValkeyConnectionManager } from './connection/valkey-connection.manager'
import { type InvalidationSubscriber } from './invalidation/invalidation-subscriber'
import { type CounterOperations } from './operations/counter.operations'
import { type HealthOperations } from './operations/health.operations'
import { type KeyValueOperations } from './operations/key-value.operations'
import { type LockOperations } from './operations/lock.operations'
import { type NamespaceOperations } from './operations/namespace.operations'
import { type ScoreOperations } from './operations/score.operations'

/*
 * The driver owns no logic of its own: it routes each leaf contract to the operation object that
 * speaks that concern. Keeping the concerns apart is what stops this from becoming the god class
 * ICacheDriver's twenty-two methods invite — the split lives here, the conveniences live in
 * CacheProviderFacade.
 */
export class ValkeyCacheDriver implements ICacheDriver {
  private readonly connections: ValkeyConnectionManager
  private readonly counters: CounterOperations
  private readonly health: HealthOperations
  private readonly keyValue: KeyValueOperations
  private readonly locks: LockOperations
  private readonly namespaces: NamespaceOperations
  private readonly onCacheError: OnCacheError
  private readonly scores: ScoreOperations
  private readonly subscriber: InvalidationSubscriber | null
  private readonly versions: NamespaceVersionResolver

  constructor(input: {
    connections: ValkeyConnectionManager
    counters: CounterOperations
    health: HealthOperations
    keyValue: KeyValueOperations
    locks: LockOperations
    namespaces: NamespaceOperations
    onCacheError: OnCacheError
    scores: ScoreOperations
    subscriber: InvalidationSubscriber | null
    versions: NamespaceVersionResolver
  }) {
    this.connections = input.connections
    this.counters = input.counters
    this.health = input.health
    this.keyValue = input.keyValue
    this.locks = input.locks
    this.namespaces = input.namespaces
    this.onCacheError = input.onCacheError
    this.scores = input.scores
    this.subscriber = input.subscriber
    this.versions = input.versions
  }

  public async connect(): ConnectProviderDTO.Output {
    const connected = await this.connections.connect()
    if (connected.isFailure()) return failure(connected.value)

    if (this.subscriber !== null) {
      const started = await this.subscriber.start()

      /*
       * A subscriber that will not come up costs the broadcast, not the cache. The memo TTL is
       * still the ceiling on the eventual window and strong mode still has no window at all, so
       * this degrades rather than refusing to connect.
       */
      if (started.isFailure()) {
        this.onCacheError({ error: started.value, key: '', namespace: '', operation: 'connect' })
      }
    }

    return success({ connected: true })
  }

  public async disconnect(): DisconnectProviderDTO.Output {
    const disconnected = await this.connections.disconnect()
    if (disconnected.isFailure()) return failure(disconnected.value)

    this.versions.clearMemo()

    return success({ disconnected: true })
  }

  public get<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    return this.keyValue.get<T>(input)
  }

  public set<T>(input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output {
    return this.keyValue.set<T>(input)
  }

  public delete(input: DeleteCacheProviderDTO.Input): DeleteCacheProviderDTO.Output {
    return this.keyValue.delete(input)
  }

  public setIfNotExists<T>(input: SetIfNotExistsCacheProviderDTO.Input<T>): SetIfNotExistsCacheProviderDTO.Output {
    return this.keyValue.setIfNotExists<T>(input)
  }

  public increment(input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output {
    return this.counters.increment(input)
  }

  public decrement(input: DecrementCounterProviderDTO.Input): DecrementCounterProviderDTO.Output {
    return this.counters.decrement(input)
  }

  public getCounter(input: GetCounterProviderDTO.Input): GetCounterProviderDTO.Output {
    return this.counters.getCounter(input)
  }

  public acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    return this.locks.acquire(input)
  }

  public release(input: ReleaseLockProviderDTO.Input): ReleaseLockProviderDTO.Output {
    return this.locks.release(input)
  }

  public extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output {
    return this.locks.extend(input)
  }

  public setScore(input: SetScoreProviderDTO.Input): SetScoreProviderDTO.Output {
    return this.scores.setScore(input)
  }

  public incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output {
    return this.scores.incrementScore(input)
  }

  public getScore(input: GetScoreProviderDTO.Input): GetScoreProviderDTO.Output {
    return this.scores.getScore(input)
  }

  public getRank(input: GetRankProviderDTO.Input): GetRankProviderDTO.Output {
    return this.scores.getRank(input)
  }

  public getTopScores(input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output {
    return this.scores.getTopScores(input)
  }

  public removeScore(input: RemoveScoreProviderDTO.Input): RemoveScoreProviderDTO.Output {
    return this.scores.removeScore(input)
  }

  public countScores(input: CountScoresProviderDTO.Input): CountScoresProviderDTO.Output {
    return this.scores.countScores(input)
  }

  public async invalidateNamespace(input: InvalidateNamespaceProviderDTO.Input): InvalidateNamespaceProviderDTO.Output {
    const invalidated = await this.namespaces.invalidate(input)
    if (invalidated.isFailure()) return failure(invalidated.value)

    /*
     * Our own memo, updated without waiting for our own message to loop back through Pub/Sub.
     * Skipping this would leave the instance that performed the invalidation as the last one to
     * learn about it, for as long as the round trip takes.
     */
    this.versions.applyBroadcast({ namespace: input.namespace, version: invalidated.value.version })

    return success({ version: invalidated.value.version })
  }

  public resolveNamespaceVersion(
    input: ResolveNamespaceVersionProviderDTO.Input
  ): ResolveNamespaceVersionProviderDTO.Output {
    return this.versions.resolveNamespaceVersion(input)
  }

  public healthCheck(input?: HealthCheckProviderDTO.Input): HealthCheckProviderDTO.Output {
    return this.health.check(input)
  }
}
```

O driver nao tem logica propria: roteia cada contrato folha para a operation daquele concern. Manter os concerns separados e o que impede isto de virar a god class que os vinte e dois metodos de `ICacheDriver` convidam — a divisao mora aqui, a conveniencia mora no `CacheProviderFacade`.

Duas decisoes de comportamento. Um subscriber que nao sobe custa o broadcast, nao o cache: o TTL do memo continua sendo o teto da janela eventual e o modo forte continua sem janela nenhuma, entao `connect` degrada em vez de recusar. E `invalidateNamespace` alimenta o proprio memo logo apos o bump, sem esperar a mensagem dar a volta pelo Pub/Sub — sem isso a instancia que invalidou seria a ultima a saber.

- [ ] **Step 2: Criar o barrel do driver**

`packages/cache/src/infra/drivers/valkey/index.ts`:

```ts
// packages/cache/src/infra/drivers/valkey/index.ts
export * from './connection/valkey-connection.manager'
export * from './invalidation/invalidation-publisher'
export * from './invalidation/invalidation-subscriber'
export * from './operations/counter.operations'
export * from './operations/health.operations'
export * from './operations/key-value.operations'
export * from './operations/lock.operations'
export * from './operations/namespace.operations'
export * from './operations/score.operations'
export * from './operations/valkey-info.parser'
export * from './physical-key.resolver'
export * from './scripts/lua-scripts'
export * from './valkey-cache.driver'
export * from './valkey-command.executor'
```

- [ ] **Step 3: Atualizar o barrel dos drivers**

`packages/cache/src/infra/drivers/index.ts`:

```ts
// packages/cache/src/infra/drivers/index.ts
export * from './memory'
export * from './noop'
export * from './valkey'
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos tres. `check:types` e o portao real: se qualquer operation nao satisfizer sua folha de `ICacheDriver`, quebra aqui.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src/infra/drivers
git commit -m "feat(cache): add the valkey cache driver"
```

---

### Task 14: Circuit breaker e Decorator de resiliencia

**Files:**

- Create: `packages/cache/src/infra/decorators/circuit-breaker.ts`
- Create: `packages/cache/src/infra/decorators/resilient-cache.provider.ts`
- Test: `packages/cache/src/infra/decorators/__tests__/circuit-breaker.unit.ts`
- Test: `packages/cache/src/infra/decorators/__tests__/resilient-cache.provider.unit.ts`

**Interfaces:**

- Consumes: `ICacheDriver`, `LockNotAcquiredError`, `LockNotOwnedError`, `NoopCacheDriver` (nos testes).
- Produces: `CircuitBreakerState`, `CircuitBreaker` (`currentState`, `shouldSkip`, `recordSuccess`, `recordFailure`), `ResilientCacheProvider implements ICacheDriver` com `state()`.

Envolve `ICacheDriver` e nao `ICacheProvider` (spec §7). E isso que faz o `getOrSet` enxergar o breaker: o cache-aside le e escreve pela mesma cadeia decorada, entao um circuito aberto transforma a leitura em miss instantaneo e o orquestrador vai direto ao `loader`, sem pagar timeout.

- [ ] **Step 1: Escrever o teste do breaker que falha**

```ts
// packages/cache/src/infra/decorators/__tests__/circuit-breaker.unit.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CircuitBreaker, CircuitBreakerState } from '../circuit-breaker'

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts closed and lets everything through', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutInMs: 1000 })

    expect(breaker.currentState()).toBe(CircuitBreakerState.CLOSED)
    expect(breaker.shouldSkip()).toBe(false)
  })

  it('opens only after the threshold of consecutive failures', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutInMs: 1000 })

    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.shouldSkip()).toBe(false)

    breaker.recordFailure()
    expect(breaker.currentState()).toBe(CircuitBreakerState.OPEN)
    expect(breaker.shouldSkip()).toBe(true)
  })

  // Consecutive, not cumulative: a cache that answers between blips is a cache that works.
  it('forgets earlier failures once a call succeeds', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutInMs: 1000 })

    breaker.recordFailure()
    breaker.recordFailure()
    breaker.recordSuccess()
    breaker.recordFailure()
    breaker.recordFailure()

    expect(breaker.currentState()).toBe(CircuitBreakerState.CLOSED)
  })

  it('half-opens once the reset window has elapsed', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutInMs: 1000 })
    breaker.recordFailure()

    vi.advanceTimersByTime(999)
    expect(breaker.currentState()).toBe(CircuitBreakerState.OPEN)

    vi.advanceTimersByTime(1)
    expect(breaker.currentState()).toBe(CircuitBreakerState.HALF_OPEN)
  })

  /*
   * Exactly one probe, which is the whole point of half-open: without the in-flight guard every
   * request that queued up during the open window would be released at once, straight into a
   * cache that is very likely still down.
   */
  it('releases exactly one probe while half-open', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutInMs: 1000 })
    breaker.recordFailure()
    vi.advanceTimersByTime(1000)

    expect(breaker.shouldSkip()).toBe(false)
    expect(breaker.shouldSkip()).toBe(true)
    expect(breaker.shouldSkip()).toBe(true)
  })

  it('closes when the probe succeeds', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutInMs: 1000 })
    breaker.recordFailure()
    vi.advanceTimersByTime(1000)
    breaker.shouldSkip()

    breaker.recordSuccess()

    expect(breaker.currentState()).toBe(CircuitBreakerState.CLOSED)
  })

  // Reopens on the first failed probe rather than waiting for the threshold a second time.
  it('reopens when the probe fails, without needing the threshold again', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutInMs: 1000 })
    for (let attempt = 0; attempt < 5; attempt += 1) breaker.recordFailure()
    vi.advanceTimersByTime(1000)
    breaker.shouldSkip()

    breaker.recordFailure()

    expect(breaker.currentState()).toBe(CircuitBreakerState.OPEN)
  })
})
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../circuit-breaker'`.

- [ ] **Step 3: Implementar o breaker**

```ts
// packages/cache/src/infra/decorators/circuit-breaker.ts
export const CircuitBreakerState = {
  CLOSED: 'closed',
  HALF_OPEN: 'half-open',
  OPEN: 'open'
} as const

export type CircuitBreakerState = (typeof CircuitBreakerState)[keyof typeof CircuitBreakerState]

/*
 * Kept apart from the decorator that uses it because it is the only part with a state machine
 * worth testing on its own: the decorator is twenty-two delegations, this is the three
 * transitions that decide whether any of them touch the network.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number
  private readonly resetTimeoutInMs: number

  private consecutiveFailures = 0
  private openedAt = 0
  private probeInFlight = false
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED

  constructor(input: { failureThreshold: number; resetTimeoutInMs: number }) {
    this.failureThreshold = input.failureThreshold
    this.resetTimeoutInMs = input.resetTimeoutInMs
  }

  public currentState(): CircuitBreakerState {
    if (this.state === CircuitBreakerState.OPEN && Date.now() - this.openedAt >= this.resetTimeoutInMs) {
      this.state = CircuitBreakerState.HALF_OPEN
      this.probeInFlight = false
    }

    return this.state
  }

  /*
   * Half-open lets exactly one call through, and `probeInFlight` is what makes that "one" true
   * under concurrency: without it every request that arrived while the window was open would be
   * released at once and hit a cache that is very likely still down.
   */
  public shouldSkip(): boolean {
    const state: CircuitBreakerState = this.currentState()

    if (state === CircuitBreakerState.OPEN) return true
    if (state === CircuitBreakerState.CLOSED) return false
    if (this.probeInFlight) return true

    this.probeInFlight = true

    return false
  }

  public recordSuccess(): void {
    this.consecutiveFailures = 0
    this.probeInFlight = false
    this.state = CircuitBreakerState.CLOSED
  }

  public recordFailure(): void {
    this.consecutiveFailures += 1
    this.probeInFlight = false

    /*
     * A failed probe reopens immediately rather than waiting for the threshold to be met a
     * second time: half-open already established that the cache was down, and the probe is the
     * evidence that it still is.
     */
    if (this.state === CircuitBreakerState.HALF_OPEN || this.consecutiveFailures >= this.failureThreshold) {
      this.state = CircuitBreakerState.OPEN
      this.openedAt = Date.now()
    }
  }
}
```

- [ ] **Step 4: Escrever o teste do decorator que falha**

```ts
// packages/cache/src/infra/decorators/__tests__/resilient-cache.provider.unit.ts
import { failure, success } from '@ruguin/utils'
import { describe, expect, it } from 'vitest'

import {
  CacheConnectionError,
  type GetCacheProviderDTO,
  type InvalidateNamespaceProviderDTO,
  type SetCacheProviderDTO
} from '../../../domain'
import { NoopCacheDriver } from '../../drivers/noop/noop-cache.driver'
import { CircuitBreakerState } from '../circuit-breaker'
import { ResilientCacheProvider } from '../resilient-cache.provider'

/*
 * Built on the noop driver so only the methods under test have to be spelled out: every other
 * leaf already answers in the shape ICacheDriver demands.
 */
class FailingDriver extends NoopCacheDriver {
  public calls = 0

  public override get<T>(): GetCacheProviderDTO.Output<T> {
    this.calls += 1

    return Promise.resolve(failure(new CacheConnectionError({ operation: 'get' })))
  }

  public override set(): SetCacheProviderDTO.Output {
    this.calls += 1

    return Promise.resolve(failure(new CacheConnectionError({ operation: 'set' })))
  }

  public override invalidateNamespace(): InvalidateNamespaceProviderDTO.Output {
    this.calls += 1

    return Promise.resolve(failure(new CacheConnectionError({ operation: 'invalidateNamespace' })))
  }
}

class CountingDriver extends NoopCacheDriver {
  public calls = 0

  public override get<T>(): GetCacheProviderDTO.Output<T> {
    this.calls += 1

    return Promise.resolve(success({ found: false, value: null as T | null }))
  }
}

const resilient = (input: { inner: NoopCacheDriver }): ResilientCacheProvider =>
  new ResilientCacheProvider({ failureThreshold: 2, inner: input.inner, resetTimeoutInMs: 10_000 })

describe('ResilientCacheProvider', () => {
  it('delegates while the circuit is closed', async () => {
    const inner = new CountingDriver()
    const provider = resilient({ inner })

    await provider.get({ key: 'a', namespace: 'user' })

    expect(inner.calls).toBe(1)
    expect(provider.state()).toBe(CircuitBreakerState.CLOSED)
  })

  /*
   * The point of the breaker: without it, fail-open still makes every request wait out the
   * connection timeout before falling through to the loader — the cache being down makes the API
   * slow rather than merely uncached.
   */
  it('stops touching the driver at all once the threshold is reached', async () => {
    const inner = new FailingDriver()
    const provider = resilient({ inner })

    await provider.get({ key: 'a', namespace: 'user' })
    await provider.get({ key: 'a', namespace: 'user' })
    expect(provider.state()).toBe(CircuitBreakerState.OPEN)

    const skipped = await provider.get({ key: 'a', namespace: 'user' })

    expect(inner.calls).toBe(2)
    if (skipped.isFailure()) throw new Error('expected a miss, not a failure')
    expect(skipped.value).toEqual({ found: false, value: null })
  })

  it('turns writes into no-ops while open, because the source of truth still holds the value', async () => {
    const inner = new FailingDriver()
    const provider = resilient({ inner })

    await provider.set({ key: 'a', namespace: 'user', value: 1 })
    await provider.set({ key: 'a', namespace: 'user', value: 1 })

    const skipped = await provider.set({ key: 'a', namespace: 'user', value: 1 })

    expect(inner.calls).toBe(2)
    expect(skipped.isSuccess()).toBe(true)
  })

  /*
   * Locks are the one operation that must not fail open. A token handed out while the breaker is
   * skipping I/O would let every concurrent caller of executeWithLock run its task and each be
   * told it held the lock exclusively.
   */
  it('refuses locks while open instead of inventing mutual exclusion', async () => {
    const inner = new FailingDriver()
    const provider = resilient({ inner })

    await provider.get({ key: 'a', namespace: 'user' })
    await provider.get({ key: 'a', namespace: 'user' })

    const acquired = await provider.acquire({ key: 'a', namespace: 'user', ttlInMs: 1000 })

    if (acquired.isSuccess()) throw new Error('expected failure')
    expect(acquired.value.name).toBe('LockNotAcquiredError')
  })

  /*
   * Never short-circuited: answering "invalidated" without touching the server is the one lie the
   * breaker cannot afford, because other instances keep serving the version this call was meant
   * to retire and the caller has been told otherwise.
   */
  it('always sends invalidateNamespace to the driver, even while open', async () => {
    const inner = new FailingDriver()
    const provider = resilient({ inner })

    await provider.invalidateNamespace({ namespace: 'user' })
    await provider.invalidateNamespace({ namespace: 'user' })
    expect(provider.state()).toBe(CircuitBreakerState.OPEN)

    const third = await provider.invalidateNamespace({ namespace: 'user' })

    expect(inner.calls).toBe(3)
    expect(third.isFailure()).toBe(true)
  })

  /*
   * The health check is the report that has to stay true: short-circuiting it would let the
   * breaker hide the very outage it is reacting to.
   */
  it('always sends healthCheck to the driver', async () => {
    const inner = new FailingDriver()
    const provider = resilient({ inner })

    await provider.get({ key: 'a', namespace: 'user' })
    await provider.get({ key: 'a', namespace: 'user' })

    const health = await provider.healthCheck()

    expect(health.isSuccess()).toBe(true)
  })
})
```

- [ ] **Step 5: Implementar o decorator**

```ts
// packages/cache/src/infra/decorators/resilient-cache.provider.ts
import { type Either, failure, success } from '@ruguin/utils'

import {
  type AcquireLockProviderDTO,
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
  LockNotAcquiredError,
  LockNotOwnedError,
  type ReleaseLockProviderDTO,
  type RemoveScoreProviderDTO,
  type ResolveNamespaceVersionProviderDTO,
  type SetCacheProviderDTO,
  type SetIfNotExistsCacheProviderDTO,
  type SetScoreProviderDTO
} from '../../domain'

import { CircuitBreaker } from './circuit-breaker'

const INITIAL_VERSION = 1

const lockKeyOf = (input: { key: string; namespace: string }): string => `${input.namespace}:__lock__:${input.key}`

/*
 * Wraps an ICacheDriver, not an ICacheProvider, and that is what makes getOrSet feel the breaker:
 * cache-aside reads and writes through this same chain, so an open circuit turns its read into
 * an instant miss and the orchestrator goes straight to the loader without paying a timeout.
 *
 * Without a breaker, fail-open is not enough on its own — every request still waits out the
 * connection timeout before falling through, so a dead cache makes the API slow rather than
 * merely uncached.
 */
export class ResilientCacheProvider implements ICacheDriver {
  private readonly breaker: CircuitBreaker
  private readonly inner: ICacheDriver

  constructor(input: {
    breaker?: CircuitBreaker
    failureThreshold: number
    inner: ICacheDriver
    resetTimeoutInMs: number
  }) {
    this.inner = input.inner
    this.breaker =
      input.breaker ??
      new CircuitBreaker({ failureThreshold: input.failureThreshold, resetTimeoutInMs: input.resetTimeoutInMs })
  }

  public get<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    return this.guard({
      execute: () => this.inner.get<T>(input),
      fallback: () => success({ found: false, value: null })
    })
  }

  public set<T>(input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output {
    /*
     * A dropped write is safe: the source of truth still holds the value and the only loss is
     * the benefit of the cache. A dropped write that *reported* failure would not be.
     */
    return this.guard({
      execute: () => this.inner.set<T>(input),
      fallback: () => success({ expiresAt: new Date() })
    })
  }

  public delete(input: DeleteCacheProviderDTO.Input): DeleteCacheProviderDTO.Output {
    return this.guard({ execute: () => this.inner.delete(input), fallback: () => success({ existed: false }) })
  }

  public setIfNotExists<T>(input: SetIfNotExistsCacheProviderDTO.Input<T>): SetIfNotExistsCacheProviderDTO.Output {
    /*
     * `stored: true`, matching the noop driver: a caller guarding a side effect on this will do
     * the work rather than skip it forever. Duplicated work is the safe failure here; omitted
     * work is not.
     */
    return this.guard({
      execute: () => this.inner.setIfNotExists<T>(input),
      fallback: () => success({ stored: true })
    })
  }

  public increment(input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output {
    return this.guard({ execute: () => this.inner.increment(input), fallback: () => success({ value: 0 }) })
  }

  public decrement(input: DecrementCounterProviderDTO.Input): DecrementCounterProviderDTO.Output {
    return this.guard({ execute: () => this.inner.decrement(input), fallback: () => success({ value: 0 }) })
  }

  public getCounter(input: GetCounterProviderDTO.Input): GetCounterProviderDTO.Output {
    return this.guard({ execute: () => this.inner.getCounter(input), fallback: () => success({ value: 0 }) })
  }

  public acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    /*
     * Refused, never granted, for the same reason the noop driver refuses. Handing out a token
     * while skipping I/O would invent mutual exclusion out of an outage, and every concurrent
     * caller of executeWithLock would be told it holds the lock alone.
     */
    return this.guard({
      execute: () => this.inner.acquire(input),
      fallback: () => failure(new LockNotAcquiredError({ attempts: 0, lockKey: lockKeyOf(input) }))
    })
  }

  public release(input: ReleaseLockProviderDTO.Input): ReleaseLockProviderDTO.Output {
    // Nothing was granted, so nothing is held: `released: false` rather than noise in onCacheError.
    return this.guard({ execute: () => this.inner.release(input), fallback: () => success({ released: false }) })
  }

  public extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output {
    // The success shape is a bare expiresAt, and there is no honest Date for a lock never granted.
    return this.guard({
      execute: () => this.inner.extend(input),
      fallback: () => failure(new LockNotOwnedError({ lockKey: lockKeyOf(input) }))
    })
  }

  public setScore(input: SetScoreProviderDTO.Input): SetScoreProviderDTO.Output {
    return this.guard({ execute: () => this.inner.setScore(input), fallback: () => success({ created: false }) })
  }

  public incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output {
    return this.guard({ execute: () => this.inner.incrementScore(input), fallback: () => success({ score: input.by }) })
  }

  public getScore(input: GetScoreProviderDTO.Input): GetScoreProviderDTO.Output {
    return this.guard({ execute: () => this.inner.getScore(input), fallback: () => success({ score: null }) })
  }

  public getRank(input: GetRankProviderDTO.Input): GetRankProviderDTO.Output {
    return this.guard({ execute: () => this.inner.getRank(input), fallback: () => success({ rank: null, total: 0 }) })
  }

  public getTopScores(input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output {
    return this.guard({ execute: () => this.inner.getTopScores(input), fallback: () => success({ entries: [] }) })
  }

  public removeScore(input: RemoveScoreProviderDTO.Input): RemoveScoreProviderDTO.Output {
    return this.guard({ execute: () => this.inner.removeScore(input), fallback: () => success({ removed: false }) })
  }

  public countScores(input: CountScoresProviderDTO.Input): CountScoresProviderDTO.Output {
    return this.guard({ execute: () => this.inner.countScores(input), fallback: () => success({ total: 0 }) })
  }

  /*
   * Recorded but never short-circuited. Answering "invalidated" without touching the server
   * would be the one lie the breaker cannot afford: other instances keep serving the version
   * this call was supposed to retire, and the caller has been told otherwise.
   */
  public invalidateNamespace(input: InvalidateNamespaceProviderDTO.Input): InvalidateNamespaceProviderDTO.Output {
    return this.record(() => this.inner.invalidateNamespace(input))
  }

  public resolveNamespaceVersion(
    input: ResolveNamespaceVersionProviderDTO.Input
  ): ResolveNamespaceVersionProviderDTO.Output {
    /*
     * Version 1 while open, matching the "never read it" default. It can address a version the
     * server has moved past, which costs a miss on reads and an unreachable key on writes — both
     * already accepted by spec §6, and both cheaper than waiting out a timeout per operation.
     */
    return this.guard({
      execute: () => this.inner.resolveNamespaceVersion(input),
      fallback: () => success({ version: INITIAL_VERSION })
    })
  }

  /*
   * Lifecycle and diagnostics pass through untouched and unrecorded. Short-circuiting the health
   * check would make the breaker hide the very outage it is reacting to, which is the one report
   * an operator needs to be true.
   */
  public connect(): ConnectProviderDTO.Output {
    return this.inner.connect()
  }

  public disconnect(): DisconnectProviderDTO.Output {
    return this.inner.disconnect()
  }

  public healthCheck(input?: HealthCheckProviderDTO.Input): HealthCheckProviderDTO.Output {
    return this.inner.healthCheck(input)
  }

  public state(): ReturnType<CircuitBreaker['currentState']> {
    return this.breaker.currentState()
  }

  private async guard<F, S>(input: {
    execute: () => Promise<Either<F, S>>
    fallback: () => Either<F, S>
  }): Promise<Either<F, S>> {
    if (this.breaker.shouldSkip()) return input.fallback()

    return this.record(input.execute)
  }

  private async record<F, S>(execute: () => Promise<Either<F, S>>): Promise<Either<F, S>> {
    const result: Either<F, S> = await execute()

    if (result.isFailure()) {
      this.breaker.recordFailure()
    } else {
      this.breaker.recordSuccess()
    }

    return result
  }
}
```

Tres classes de comportamento, e a assimetria e o ponto:

| Grupo                                    | Com o circuito aberto                        | Por que                                                                                      |
| ---------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Leituras e escritas                      | miss / no-op de sucesso                      | a fonte da verdade continua correta; a unica perda e o beneficio do cache                    |
| Locks                                    | `LockNotAcquiredError` / `LockNotOwnedError` | conceder seria fabricar exclusao mutua a partir de uma queda                                 |
| `invalidateNamespace`                    | vai ao servidor mesmo assim                  | responder "invalidado" sem tocar no servidor e a unica mentira que o breaker nao pode contar |
| `connect` / `disconnect` / `healthCheck` | passam direto, sem registrar                 | curto-circuitar o health faria o breaker esconder a queda a que esta reagindo                |

- [ ] **Step 6: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos tres.

- [ ] **Step 7: Commit**

```bash
git add packages/cache/src/infra/decorators
git commit -m "feat(cache): add the circuit breaker and the resilient cache decorator"
```

---

### Task 15: Decorator de observabilidade

**Files:**

- Create: `packages/cache/src/infra/decorators/observable-cache.provider.ts`
- Create: `packages/cache/src/infra/decorators/index.ts`
- Test: `packages/cache/src/infra/decorators/__tests__/observable-cache.provider.unit.ts`

**Interfaces:**

- Consumes: `Attributes`, `Span`, `SpanStatusCode`, `Tracer`, `trace` de `@opentelemetry/api`; `ICacheDriver`; `CacheDriver`.
- Produces: `ObservableCacheProvider implements ICacheDriver`.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// packages/cache/src/infra/decorators/__tests__/observable-cache.provider.unit.ts
import {
  type Attributes,
  type AttributeValue,
  type Span,
  type SpanContext,
  type SpanStatus,
  SpanStatusCode,
  type Tracer
} from '@opentelemetry/api'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it } from 'vitest'

import { CacheConnectionError, CacheDriver, type GetCacheProviderDTO } from '../../../domain'
import { NoopCacheDriver } from '../../drivers/noop/noop-cache.driver'
import { ObservableCacheProvider } from '../observable-cache.provider'

type Recorded = { attributes: Attributes; name: string; status: SpanStatusCode | null; wasEnded: boolean }

/*
 * A recording stand-in rather than the real SDK: the decorator's contract is which span it opens
 * and what it puts on that span, and asserting it against a live exporter would test the exporter.
 */
class FakeSpan implements Span {
  private readonly recorded: Recorded

  constructor(input: { recorded: Recorded }) {
    this.recorded = input.recorded
  }

  public addEvent(): this {
    return this
  }

  public addLink(): this {
    return this
  }

  public addLinks(): this {
    return this
  }

  public end(): void {
    this.recorded.wasEnded = true
  }

  public isRecording(): boolean {
    return true
  }

  public recordException(): void {
    // Not exercised: the decorator reports failures through setStatus, not exceptions.
  }

  public setAttribute(key: string, value: AttributeValue): this {
    this.recorded.attributes[key] = value

    return this
  }

  public setAttributes(attributes: Attributes): this {
    Object.assign(this.recorded.attributes, attributes)

    return this
  }

  public setStatus(status: SpanStatus): this {
    this.recorded.status = status.code

    return this
  }

  public spanContext(): SpanContext {
    return { spanId: '0'.repeat(16), traceFlags: 0, traceId: '0'.repeat(32) }
  }

  public updateName(): this {
    return this
  }
}

const recordingTracer = (input: { spans: Recorded[] }): Tracer => ({
  startActiveSpan: () => {
    throw new Error('ObservableCacheProvider opens leaf spans with startSpan')
  },
  startSpan: (name, options): Span => {
    const recorded: Recorded = { attributes: { ...options?.attributes }, name, status: null, wasEnded: false }
    input.spans.push(recorded)

    return new FakeSpan({ recorded })
  }
})

class HittingDriver extends NoopCacheDriver {
  public override get<T>(): GetCacheProviderDTO.Output<T> {
    return Promise.resolve(success({ found: true, value: null as T | null }))
  }
}

class BrokenDriver extends NoopCacheDriver {
  public override get<T>(): GetCacheProviderDTO.Output<T> {
    return Promise.resolve(failure(new CacheConnectionError({ operation: 'get' })))
  }
}

describe('ObservableCacheProvider', () => {
  it('opens one span per operation, tagged with driver, operation and namespace', async () => {
    const spans: Recorded[] = []
    const provider = new ObservableCacheProvider({
      driver: CacheDriver.VALKEY,
      inner: new HittingDriver(),
      tracer: recordingTracer({ spans })
    })

    await provider.get({ key: 'a', namespace: 'user' })

    expect(spans).toHaveLength(1)
    expect(spans[0]?.name).toBe('cache.get')
    expect(spans[0]?.attributes).toMatchObject({
      'cache.driver': 'valkey',
      'cache.namespace': 'user',
      'cache.operation': 'get'
    })
  })

  // Hit rate becomes measurable without a second instrumentation pass over every call site.
  it('records whether the read hit', async () => {
    const spans: Recorded[] = []
    const provider = new ObservableCacheProvider({
      driver: CacheDriver.VALKEY,
      inner: new HittingDriver(),
      tracer: recordingTracer({ spans })
    })

    await provider.get({ key: 'a', namespace: 'user' })

    expect(spans[0]?.attributes['cache.hit']).toBe(true)
    expect(spans[0]?.attributes['cache.outcome']).toBe('ok')
  })

  it('marks the span as an error when the driver fails', async () => {
    const spans: Recorded[] = []
    const provider = new ObservableCacheProvider({
      driver: CacheDriver.VALKEY,
      inner: new BrokenDriver(),
      tracer: recordingTracer({ spans })
    })

    await provider.get({ key: 'a', namespace: 'user' })

    expect(spans[0]?.status).toBe(SpanStatusCode.ERROR)
    expect(spans[0]?.attributes['cache.outcome']).toBe('error')
  })

  // The decorator must be transparent: same Either in, same Either out, span closed either way.
  it('hands the driver result back untouched', async () => {
    const spans: Recorded[] = []
    const provider = new ObservableCacheProvider({
      driver: CacheDriver.VALKEY,
      inner: new BrokenDriver(),
      tracer: recordingTracer({ spans })
    })

    const result = await provider.get({ key: 'a', namespace: 'user' })

    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value.name).toBe('CacheConnectionError')
    expect(spans[0]?.wasEnded).toBe(true)
  })

  it('omits the namespace attribute on operations that have none', async () => {
    const spans: Recorded[] = []
    const provider = new ObservableCacheProvider({
      driver: CacheDriver.NOOP,
      inner: new NoopCacheDriver(),
      tracer: recordingTracer({ spans })
    })

    await provider.connect()

    expect(spans[0]?.name).toBe('cache.connect')
    expect(spans[0]?.attributes['cache.namespace']).toBeUndefined()
  })
})
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../observable-cache.provider'`.

- [ ] **Step 3: Implementar**

```ts
// packages/cache/src/infra/decorators/observable-cache.provider.ts
import { type Attributes, type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api'
import { type Either } from '@ruguin/utils'

import {
  type AcquireLockProviderDTO,
  type CacheDriver,
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
} from '../../domain'

const TRACER_NAME = '@ruguin/cache'

/*
 * Applied outside the breaker — observable(resilient(driver)) — so a call the breaker
 * short-circuited still produces a span. Ordering it the other way round would make the cache
 * look silent precisely when it is failing, which is the moment the trace matters most.
 */
export class ObservableCacheProvider implements ICacheDriver {
  private readonly driver: CacheDriver
  private readonly inner: ICacheDriver
  private readonly tracer: Tracer

  constructor(input: { driver: CacheDriver; inner: ICacheDriver; tracer?: Tracer }) {
    this.driver = input.driver
    this.inner = input.inner
    this.tracer = input.tracer ?? trace.getTracer(TRACER_NAME)
  }

  public get<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    return this.observe({
      describe: (value) => ({ 'cache.hit': value.found }),
      execute: () => this.inner.get<T>(input),
      namespace: input.namespace,
      operation: 'get'
    })
  }

  public set<T>(input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output {
    return this.observe({ execute: () => this.inner.set<T>(input), namespace: input.namespace, operation: 'set' })
  }

  public delete(input: DeleteCacheProviderDTO.Input): DeleteCacheProviderDTO.Output {
    return this.observe({ execute: () => this.inner.delete(input), namespace: input.namespace, operation: 'delete' })
  }

  public setIfNotExists<T>(input: SetIfNotExistsCacheProviderDTO.Input<T>): SetIfNotExistsCacheProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.setIfNotExists<T>(input),
      namespace: input.namespace,
      operation: 'setIfNotExists'
    })
  }

  public increment(input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.increment(input),
      namespace: input.namespace,
      operation: 'increment'
    })
  }

  public decrement(input: DecrementCounterProviderDTO.Input): DecrementCounterProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.decrement(input),
      namespace: input.namespace,
      operation: 'decrement'
    })
  }

  public getCounter(input: GetCounterProviderDTO.Input): GetCounterProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.getCounter(input),
      namespace: input.namespace,
      operation: 'getCounter'
    })
  }

  public acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    return this.observe({ execute: () => this.inner.acquire(input), namespace: input.namespace, operation: 'acquire' })
  }

  public release(input: ReleaseLockProviderDTO.Input): ReleaseLockProviderDTO.Output {
    return this.observe({ execute: () => this.inner.release(input), namespace: input.namespace, operation: 'release' })
  }

  public extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output {
    return this.observe({ execute: () => this.inner.extend(input), namespace: input.namespace, operation: 'extend' })
  }

  public setScore(input: SetScoreProviderDTO.Input): SetScoreProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.setScore(input),
      namespace: input.namespace,
      operation: 'setScore'
    })
  }

  public incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.incrementScore(input),
      namespace: input.namespace,
      operation: 'incrementScore'
    })
  }

  public getScore(input: GetScoreProviderDTO.Input): GetScoreProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.getScore(input),
      namespace: input.namespace,
      operation: 'getScore'
    })
  }

  public getRank(input: GetRankProviderDTO.Input): GetRankProviderDTO.Output {
    return this.observe({ execute: () => this.inner.getRank(input), namespace: input.namespace, operation: 'getRank' })
  }

  public getTopScores(input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.getTopScores(input),
      namespace: input.namespace,
      operation: 'getTopScores'
    })
  }

  public removeScore(input: RemoveScoreProviderDTO.Input): RemoveScoreProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.removeScore(input),
      namespace: input.namespace,
      operation: 'removeScore'
    })
  }

  public countScores(input: CountScoresProviderDTO.Input): CountScoresProviderDTO.Output {
    return this.observe({
      execute: () => this.inner.countScores(input),
      namespace: input.namespace,
      operation: 'countScores'
    })
  }

  public invalidateNamespace(input: InvalidateNamespaceProviderDTO.Input): InvalidateNamespaceProviderDTO.Output {
    return this.observe({
      describe: (value) => ({ 'cache.namespace.version': value.version }),
      execute: () => this.inner.invalidateNamespace(input),
      namespace: input.namespace,
      operation: 'invalidateNamespace'
    })
  }

  public resolveNamespaceVersion(
    input: ResolveNamespaceVersionProviderDTO.Input
  ): ResolveNamespaceVersionProviderDTO.Output {
    return this.observe({
      describe: (value) => ({ 'cache.namespace.version': value.version }),
      execute: () => this.inner.resolveNamespaceVersion(input),
      namespace: input.namespace,
      operation: 'resolveNamespaceVersion'
    })
  }

  public connect(): ConnectProviderDTO.Output {
    return this.observe({ execute: () => this.inner.connect(), operation: 'connect' })
  }

  public disconnect(): DisconnectProviderDTO.Output {
    return this.observe({ execute: () => this.inner.disconnect(), operation: 'disconnect' })
  }

  public healthCheck(input?: HealthCheckProviderDTO.Input): HealthCheckProviderDTO.Output {
    return this.observe({
      describe: (value) => ({ 'cache.health.status': value.status }),
      execute: () => this.inner.healthCheck(input),
      operation: 'healthCheck'
    })
  }

  private async observe<F, S>(input: {
    describe?: (value: S) => Attributes
    execute: () => Promise<Either<F, S>>
    namespace?: string
    operation: string
  }): Promise<Either<F, S>> {
    const attributes: Attributes = { 'cache.driver': this.driver, 'cache.operation': input.operation }
    if (input.namespace !== undefined) attributes['cache.namespace'] = input.namespace

    const span: Span = this.tracer.startSpan(`cache.${input.operation}`, { attributes })

    try {
      const result: Either<F, S> = await input.execute()

      if (result.isFailure()) {
        span.setAttribute('cache.outcome', 'error')
        span.setStatus({ code: SpanStatusCode.ERROR })
      } else {
        span.setAttribute('cache.outcome', 'ok')
        if (input.describe !== undefined) span.setAttributes(input.describe(result.value))
      }

      return result
    } finally {
      span.end()
    }
  }
}
```

Os spans sao abertos com `startSpan` e nao `startActiveSpan`. `startSpan` ja usa o contexto ativo, entao o span nasce filho do span da requisicao; o que ele nao faz e virar o span ativo — o que so importaria se houvesse trabalho instrumentado aninhado dentro, e nao ha: cada operacao de cache e uma folha.

- [ ] **Step 4: Criar o barrel dos decorators**

`packages/cache/src/infra/decorators/index.ts`:

```ts
// packages/cache/src/infra/decorators/index.ts
export * from './circuit-breaker'
export * from './observable-cache.provider'
export * from './resilient-cache.provider'
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos tres.

- [ ] **Step 6: Commit**

```bash
git add packages/cache/src/infra/decorators
git commit -m "feat(cache): add the observable cache decorator with otel spans"
```

---

### Task 16: Factory e raiz de composicao

**Files:**

- Create: `packages/cache/src/domain/errors/invalid-cache-config.error.ts`
- Modify: `packages/cache/src/domain/errors/index.ts`
- Create: `packages/cache/src/factory/create-valkey-driver.ts`
- Create: `packages/cache/src/factory/cache.factory.ts`
- Create: `packages/cache/src/factory/index.ts`
- Modify: `packages/cache/src/infra/index.ts`
- Modify: `packages/cache/src/index.ts`
- Test: `packages/cache/src/factory/__tests__/cache.factory.unit.ts`

**Interfaces:**

- Consumes: tudo construido ate aqui, mais `CacheProviderFacade`, `GetOrSetCacheProvider`, `ExecuteWithLockProvider` do plano 1.
- Produces: `InvalidCacheConfigError`; `ValkeyDriverConfig` e `createValkeyDriver`; `CacheFactoryDTO.Config` / `.OutputError` / `.Output` e `CacheFactory.create(input): Either<InvalidCacheConfigError, ICacheProvider>`.

`InvalidCacheConfigError` nao esta na tabela §11 da spec, e e adicionado aqui de proposito. O schema de `@ruguin/env` ja recusa `CACHE_DRIVER=valkey` sem `CACHE_MASTER_URL` no boot, mas a factory recebe um objeto de config cru e e alcancavel a partir de um teste ou de um servico que nunca passou pelo schema. `INVALID_INPUT` porque composicao mal configurada e erro de quem chama, nao queda de infraestrutura.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// packages/cache/src/factory/__tests__/cache.factory.unit.ts
import { success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { CacheConsistency, CacheDriver, CacheLockOutcome, CacheSource } from '../../domain'
import { CacheFactory, type CacheFactoryDTO } from '../cache.factory'

const baseConfig = (overrides: Partial<CacheFactoryDTO.Config>): CacheFactoryDTO.Config => ({
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
  onCacheError: vi.fn(),
  operationTimeoutInMs: 500,
  prefix: 'ruguin:test',
  replicationLagThresholdInBytes: 1_048_576,
  ...overrides
})

describe('CacheFactory', () => {
  it('builds a working memory provider', async () => {
    const created = CacheFactory.create(baseConfig({ driver: CacheDriver.MEMORY }))

    if (created.isFailure()) throw new Error('expected success')
    const provider = created.value
    await provider.connect()

    await provider.set({ key: 'a', namespace: 'user', value: { id: '1' } })
    const read = await provider.get<{ id: string }>({ key: 'a', namespace: 'user' })

    if (read.isFailure()) throw new Error('expected success')
    expect(read.value).toEqual({ found: true, value: { id: '1' } })
  })

  it('builds the noop provider, which misses on every read', async () => {
    const created = CacheFactory.create(baseConfig({ driver: CacheDriver.NOOP }))

    if (created.isFailure()) throw new Error('expected success')
    await created.value.connect()

    const read = await created.value.get({ key: 'a', namespace: 'user' })

    if (read.isFailure()) throw new Error('expected success')
    expect(read.value.found).toBe(false)
  })

  /*
   * @ruguin/env already refuses this combination at boot, but the factory takes a plain config
   * object and is reachable from a test or a service that never went through the env schema.
   */
  it('refuses the valkey driver without a master url', () => {
    const created = CacheFactory.create(baseConfig({ driver: CacheDriver.VALKEY }))

    if (created.isSuccess()) throw new Error('expected failure')
    expect(created.value.name).toBe('InvalidCacheConfigError')
    expect(created.value.message).toContain('masterUrl')
  })

  it('composes the two orchestrators on top of the driver', async () => {
    const created = CacheFactory.create(baseConfig({}))

    if (created.isFailure()) throw new Error('expected success')
    await created.value.connect()

    const loaded = await created.value.getOrSet<number, Error>({
      key: 'a',
      loader: () => Promise.resolve(success(42)),
      namespace: 'user'
    })

    if (loaded.isFailure()) throw new Error('expected success')
    expect(loaded.value.source).toBe(CacheSource.LOADER)
    expect(loaded.value.lockOutcome).toBe(CacheLockOutcome.NOT_ATTEMPTED)
  })
})
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm --filter @ruguin/cache test:unit`
Expected: FAIL — `Cannot find module '../cache.factory'`.

- [ ] **Step 3: Adicionar o erro de configuracao**

```ts
// packages/cache/src/domain/errors/invalid-cache-config.error.ts
import { BaseError, StatusError } from '@ruguin/ddd-kernel'

/*
 * Raised by the composition root, not by an operation. `@ruguin/env` already refuses a `valkey`
 * driver with no master URL at boot, but the factory takes a plain config object and is reachable
 * from a test or a service that never went through the env schema — so the check lives here too,
 * and it is INVALID_INPUT because a misconfigured composition is a caller mistake, not an outage.
 */
export class InvalidCacheConfigError extends BaseError {
  readonly name = 'InvalidCacheConfigError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { reason: string; setting: string }) {
    super({ message: `Invalid cache configuration for "${input.setting}": ${input.reason}` })
  }
}
```

`packages/cache/src/domain/errors/index.ts`:

```ts
// packages/cache/src/domain/errors/index.ts
export * from './cache-connection.error'
export * from './cache-not-initialized.error'
export * from './cache-operation.error'
export * from './cache-serialization.error'
export * from './cache-timeout.error'
export * from './invalid-cache-config.error'
export * from './invalid-cache-key.error'
export * from './lock-not-acquired.error'
export * from './lock-not-owned.error'
```

- [ ] **Step 4: Completar o barrel de `infra`**

`packages/cache/src/infra/index.ts`:

```ts
// packages/cache/src/infra/index.ts
export * from './apply-ttl-jitter'
export * from './decorators'
export * from './drivers'
export * from './key-builder'
export * from './namespace-version.resolver'
export * from './serializers'
```

- [ ] **Step 5: Implementar a fiacao do driver Valkey**

```ts
// packages/cache/src/factory/create-valkey-driver.ts
import { type RedisOptions } from 'iovalkey'

import { type OnCacheError } from '../application'
import { type CacheConsistency, type ISerializerStrategy } from '../domain'
import {
  CounterOperations,
  HealthOperations,
  InvalidationPublisher,
  InvalidationSubscriber,
  type KeyBuilder,
  KeyValueOperations,
  LockOperations,
  type NamespaceConfig,
  NamespaceOperations,
  NamespaceVersionResolver,
  PhysicalKeyResolver,
  ScoreOperations,
  ValkeyCacheDriver,
  ValkeyCommandExecutor,
  ValkeyConnectionManager
} from '../infra'

export type ValkeyDriverConfig = Readonly<{
  connectionOptions?: RedisOptions
  defaultConsistency: CacheConsistency
  defaultTtlInMs: number
  invalidationBroadcast: boolean
  jitterRatio: number
  keyBuilder: KeyBuilder
  masterUrl: string
  namespaces: NamespaceConfig
  namespaceVersionLocalTtlInMs: number
  onCacheError: OnCacheError
  operationTimeoutInMs: number
  prefix: string
  replicaUrls: readonly string[]
  replicationLagThresholdInBytes: number
  serializer: ISerializerStrategy
}>

/*
 * Wiring, kept out of CacheFactory because the Valkey family has eleven collaborators and the
 * other two families have one each. Assembling it inline would bury the driver *selection* — the
 * factory's actual job — under the construction of a single branch.
 */
export const createValkeyDriver = (input: ValkeyDriverConfig): ValkeyCacheDriver => {
  const connections = new ValkeyConnectionManager({
    masterUrl: input.masterUrl,
    replicaUrls: input.replicaUrls,
    withSubscriber: input.invalidationBroadcast,
    ...(input.connectionOptions !== undefined && { options: input.connectionOptions })
  })

  const executor = new ValkeyCommandExecutor({ timeoutInMs: input.operationTimeoutInMs })

  const publisher: InvalidationPublisher | null = input.invalidationBroadcast
    ? new InvalidationPublisher({
        connections,
        executor,
        onCacheError: input.onCacheError,
        prefix: input.prefix
      })
    : null

  const namespaces = new NamespaceOperations({ connections, executor, keyBuilder: input.keyBuilder, publisher })

  const versions = new NamespaceVersionResolver({
    defaultConsistency: input.defaultConsistency,
    localTtlInMs: input.namespaceVersionLocalTtlInMs,
    namespaces: input.namespaces,
    source: { fetchVersion: (lookup) => namespaces.fetchVersion(lookup) }
  })

  const keys = new PhysicalKeyResolver({ keyBuilder: input.keyBuilder, versions })

  return new ValkeyCacheDriver({
    connections,
    counters: new CounterOperations({ connections, executor, keys }),
    health: new HealthOperations({
      connections,
      executor,
      replicationLagThresholdInBytes: input.replicationLagThresholdInBytes
    }),
    keyValue: new KeyValueOperations({
      connections,
      defaultTtlInMs: input.defaultTtlInMs,
      executor,
      jitterRatio: input.jitterRatio,
      keyBuilder: input.keyBuilder,
      keys,
      prefix: input.prefix,
      serializer: input.serializer,
      versions
    }),
    locks: new LockOperations({ connections, executor, keyBuilder: input.keyBuilder }),
    namespaces,
    onCacheError: input.onCacheError,
    scores: new ScoreOperations({ connections, executor, keys }),
    subscriber: input.invalidationBroadcast
      ? new InvalidationSubscriber({
          connections,
          executor,
          onCacheError: input.onCacheError,
          prefix: input.prefix,
          versions
        })
      : null,
    versions
  })
}
```

Fica fora da `CacheFactory` porque a familia Valkey tem onze colaboradores e as outras duas tem um cada. Montar isso inline soterraria a **selecao** de driver — o trabalho de verdade da factory — sob a construcao de um unico ramo.

- [ ] **Step 6: Implementar a factory**

```ts
// packages/cache/src/factory/cache.factory.ts
import { type Either, failure, success } from '@ruguin/utils'
import { type RedisOptions } from 'iovalkey'

import { CacheProviderFacade, ExecuteWithLockProvider, GetOrSetCacheProvider, type OnCacheError } from '../application'
import {
  type CacheConsistency,
  CacheDriver,
  type ICacheDriver,
  type ICacheProvider,
  InvalidCacheConfigError
} from '../domain'
import {
  JsonSerializerStrategy,
  KeyBuilder,
  MemoryCacheDriver,
  type NamespaceConfig,
  NoopCacheDriver,
  ObservableCacheProvider,
  ResilientCacheProvider
} from '../infra'

import { createValkeyDriver } from './create-valkey-driver'

export namespace CacheFactoryDTO {
  export type Config = Readonly<{
    breaker: Readonly<{ failureThreshold: number; resetTimeoutInMs: number }>
    connectionOptions?: RedisOptions
    defaultConsistency: CacheConsistency
    defaultTtlInMs: number
    driver: CacheDriver
    invalidationBroadcast: boolean
    jitterRatio: number
    lockTtlInMs: number
    masterUrl?: string
    namespaces?: NamespaceConfig
    namespaceVersionLocalTtlInMs: number
    negativeTtlInMs: number
    observability?: boolean
    onCacheError: OnCacheError
    operationTimeoutInMs: number
    prefix: string
    replicaUrls?: readonly string[]
    replicationLagThresholdInBytes: number
  }>

  export type OutputError = Readonly<InvalidCacheConfigError>

  export type Output = Either<OutputError, ICacheProvider>
}

const buildDriver = (input: CacheFactoryDTO.Config): Either<InvalidCacheConfigError, ICacheDriver> => {
  if (input.driver === CacheDriver.NOOP) return success(new NoopCacheDriver())

  const keyBuilder = new KeyBuilder({ prefix: input.prefix })
  const serializer = new JsonSerializerStrategy()

  if (input.driver === CacheDriver.MEMORY) {
    return success(
      new MemoryCacheDriver({
        defaultTtlInMs: input.defaultTtlInMs,
        jitterRatio: input.jitterRatio,
        keyBuilder,
        serializer
      })
    )
  }

  const masterUrl: string | undefined = input.masterUrl
  if (masterUrl === undefined || masterUrl.length === 0) {
    return failure(
      new InvalidCacheConfigError({
        reason: 'a master url is required when the driver is "valkey"',
        setting: 'masterUrl'
      })
    )
  }

  return success(
    createValkeyDriver({
      defaultConsistency: input.defaultConsistency,
      defaultTtlInMs: input.defaultTtlInMs,
      invalidationBroadcast: input.invalidationBroadcast,
      jitterRatio: input.jitterRatio,
      keyBuilder,
      masterUrl,
      namespaces: input.namespaces ?? {},
      namespaceVersionLocalTtlInMs: input.namespaceVersionLocalTtlInMs,
      onCacheError: input.onCacheError,
      operationTimeoutInMs: input.operationTimeoutInMs,
      prefix: input.prefix,
      replicaUrls: input.replicaUrls ?? [],
      replicationLagThresholdInBytes: input.replicationLagThresholdInBytes,
      serializer,
      ...(input.connectionOptions !== undefined && { connectionOptions: input.connectionOptions })
    })
  )
}

/*
 * observable(resilient(driver)), in that order. The span therefore covers the breaker's own
 * decision, including the calls it short-circuits — reversed, the trace would fall silent at
 * exactly the moment someone is reading it to find out why the cache stopped helping.
 */
const decorate = (input: { config: CacheFactoryDTO.Config; driver: ICacheDriver }): ICacheDriver => {
  const resilient: ICacheDriver = new ResilientCacheProvider({
    failureThreshold: input.config.breaker.failureThreshold,
    inner: input.driver,
    resetTimeoutInMs: input.config.breaker.resetTimeoutInMs
  })

  if (input.config.observability === false) return resilient

  return new ObservableCacheProvider({ driver: input.config.driver, inner: resilient })
}

/*
 * The single composition root. Every wiring decision the package makes — which driver family,
 * which decorators, which orchestrators sit on top — is spelled out once here, so a service that
 * wants a cache asks for one instead of assembling twelve objects in the right order.
 *
 * An object rather than a class with static methods: there is no instance state to hold, and a
 * class that never gets constructed is a namespace wearing a costume.
 */
export const CacheFactory = {
  create: (input: CacheFactoryDTO.Config): CacheFactoryDTO.Output => {
    const driver = buildDriver(input)
    if (driver.isFailure()) return failure(driver.value)

    const decorated: ICacheDriver = decorate({ config: input, driver: driver.value })

    /*
     * Both orchestrators receive the *decorated* driver, not the raw one. That is what makes
     * getOrSet's read see the breaker: an open circuit turns it into an instant miss and
     * cache-aside falls through to the loader without paying a timeout.
     */
    return success(
      new CacheProviderFacade({
        driver: decorated,
        executeWithLockProvider: new ExecuteWithLockProvider({
          lockAcquirer: decorated,
          lockReleaser: decorated,
          onCacheError: input.onCacheError
        }),
        getOrSetProvider: new GetOrSetCacheProvider({
          lockAcquirer: decorated,
          lockReleaser: decorated,
          lockTtlInMs: input.lockTtlInMs,
          negativeTtlInMs: input.negativeTtlInMs,
          onCacheError: input.onCacheError,
          reader: decorated,
          writer: decorated
        })
      })
    )
  }
} as const
```

Um objeto, e nao uma classe com metodos estaticos: nao ha estado de instancia a guardar, e `@typescript-eslint/no-extraneous-class` recusa a classe que nunca e construida. A API publica continua `CacheFactory.create(...)`, como a spec §1.2 descreve.

A ordem `observable(resilient(driver))` importa: o span cobre inclusive as chamadas que o breaker curto-circuita. Invertida, o trace ficaria mudo exatamente no momento em que alguem o abre para descobrir por que o cache parou de ajudar.

- [ ] **Step 7: Criar o barrel da factory e o barrel raiz**

`packages/cache/src/factory/index.ts`:

```ts
// packages/cache/src/factory/index.ts
export * from './cache.factory'
export * from './create-valkey-driver'
```

`packages/cache/src/index.ts`:

```ts
// packages/cache/src/index.ts
export * from './application'
export * from './domain'
export * from './factory'
export * from './infra'
```

- [ ] **Step 8: Rodar e confirmar que passa**

Run: `pnpm --filter @ruguin/cache test:unit && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos tres.

- [ ] **Step 9: Commit**

```bash
git add packages/cache/src
git commit -m "feat(cache): add the cache factory as the single composition root"
```

---

### Task 17: Testes de integracao contra Valkey real

**Files:**

- Create: `packages/cache/src/infra/drivers/valkey/__tests__/valkey-test-context.ts`
- Test: `packages/cache/src/infra/drivers/valkey/connection/__tests__/valkey-connection.manager.int.ts`
- Test: `packages/cache/src/infra/drivers/valkey/operations/__tests__/key-value.operations.int.ts`
- Test: `packages/cache/src/infra/drivers/valkey/operations/__tests__/lock.operations.int.ts`
- Test: `packages/cache/src/infra/drivers/valkey/operations/__tests__/health.operations.int.ts`
- Test: `packages/cache/src/infra/drivers/valkey/__tests__/valkey-cache.driver.int.ts`

**Interfaces:**

- Consumes: `CacheFactory`, `ValkeyConnectionManager`, `Redis` de `iovalkey`.
- Produces: `MASTER_URL`, `REPLICA_URL`, `TestCache`, `uniquePrefix`, `createValkeyCache`, `sleep`.

Semantica de `SET NX PX`, expiracao efetiva de TTL, compare-and-swap em Lua e parse de um `INFO` vivo nao se provam com mock. Estes sao os testes que o `test:integration` roda no CI, com o `docker-compose` da Task 1 no ar.

- [ ] **Step 1: Criar o contexto compartilhado**

Nao termina em `.unit.ts` nem em `.int.ts`, entao o vitest nao o coleta como suite.

```ts
// packages/cache/src/infra/drivers/valkey/__tests__/valkey-test-context.ts
import { type OnCacheError } from '../../../../application'
import { CacheConsistency, CacheDriver, type ICacheProvider } from '../../../../domain'
import { CacheFactory } from '../../../../factory'
import { type NamespaceConfig } from '../../../namespace-version.resolver'

export const MASTER_URL: string = process.env.CACHE_TEST_MASTER_URL ?? 'redis://localhost:6379'
export const REPLICA_URL: string = process.env.CACHE_TEST_REPLICA_URL ?? 'redis://localhost:6380'

export type TestCache = Readonly<{ errors: unknown[]; provider: ICacheProvider }>

/*
 * A fresh prefix per file, so a run that dies half way never leaves keys that make the next run
 * pass — or fail — for reasons that have nothing to do with the code. Nothing in this package
 * can SCAN the keyspace, so leftovers are invisible rather than harmful, and they expire anyway.
 */
export const uniquePrefix = (input: { label: string }): string =>
  `ruguin-test:${input.label}:${crypto.randomUUID().slice(0, 8)}`

export const createValkeyCache = (input: {
  invalidationBroadcast?: boolean
  namespaces?: NamespaceConfig
  namespaceVersionLocalTtlInMs?: number
  prefix: string
  replicaUrls?: readonly string[]
}): TestCache => {
  const errors: unknown[] = []
  const onCacheError: OnCacheError = (report) => {
    errors.push(report)
  }

  const created = CacheFactory.create({
    /*
     * Far above anything a green run produces: the breaker is unit-tested on its own, and letting
     * it trip here would turn one slow command into a cascade of unrelated assertion failures.
     */
    breaker: { failureThreshold: 1000, resetTimeoutInMs: 1000 },
    defaultConsistency: CacheConsistency.EVENTUAL,
    defaultTtlInMs: 60_000,
    driver: CacheDriver.VALKEY,
    invalidationBroadcast: input.invalidationBroadcast ?? false,
    // Off, so a written TTL is exactly the TTL the assertion expects.
    jitterRatio: 0,
    lockTtlInMs: 5000,
    masterUrl: MASTER_URL,
    namespaces: input.namespaces ?? {},
    namespaceVersionLocalTtlInMs: input.namespaceVersionLocalTtlInMs ?? 5000,
    negativeTtlInMs: 30_000,
    observability: false,
    onCacheError,
    operationTimeoutInMs: 2000,
    prefix: input.prefix,
    replicaUrls: input.replicaUrls ?? [],
    replicationLagThresholdInBytes: 1_048_576
  })

  if (created.isFailure()) throw new Error(created.value.message)

  return { errors, provider: created.value }
}

export const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
```

- [ ] **Step 2: Escrever os testes de conexao e roteamento**

```ts
// packages/cache/src/infra/drivers/valkey/connection/__tests__/valkey-connection.manager.int.ts
import { Redis } from 'iovalkey'
import { afterAll, describe, expect, it } from 'vitest'

import { MASTER_URL, REPLICA_URL } from '../../__tests__/valkey-test-context'
import { ValkeyConnectionManager } from '../valkey-connection.manager'

const managers: ValkeyConnectionManager[] = []

const connected = async (input: {
  replicaUrls?: readonly string[]
  withSubscriber?: boolean
}): Promise<ValkeyConnectionManager> => {
  const manager = new ValkeyConnectionManager({
    masterUrl: MASTER_URL,
    replicaUrls: input.replicaUrls ?? [],
    withSubscriber: input.withSubscriber ?? false
  })
  managers.push(manager)

  const result = await manager.connect()
  if (result.isFailure()) throw new Error(result.value.message)

  return manager
}

describe('ValkeyConnectionManager', () => {
  afterAll(async () => {
    await Promise.all(managers.map(async (manager) => manager.disconnect()))
  })

  it('refuses every client until connect() has run', () => {
    const manager = new ValkeyConnectionManager({ masterUrl: MASTER_URL, withSubscriber: false })

    const master = manager.master()

    if (master.isSuccess()) throw new Error('expected failure')
    expect(master.value.name).toBe('CacheNotInitializedError')
  })

  it('connects to the master and answers a PING', async () => {
    const manager = await connected({})

    const master = manager.master()
    if (master.isFailure()) throw new Error('expected success')
    await expect(master.value.ping()).resolves.toBe('PONG')
  })

  it('reports a refused connection as a connection error rather than throwing', async () => {
    const manager = new ValkeyConnectionManager({
      masterUrl: 'redis://127.0.0.1:6399',
      options: { connectTimeout: 300, retryStrategy: () => null },
      withSubscriber: false
    })

    const result = await manager.connect()

    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value.name).toBe('CacheConnectionError')
  })

  it('routes reads to the master when no replica is configured', async () => {
    const manager = await connected({})

    const reader = manager.reader()
    const master = manager.master()

    if (reader.isFailure() || master.isFailure()) throw new Error('expected success')
    expect(reader.value).toBe(master.value)
  })

  it('opens a third connection for the subscriber, because subscribe mode refuses commands', async () => {
    const manager = await connected({ withSubscriber: true })

    const subscriber = manager.subscriber()
    const master = manager.master()

    if (subscriber.isFailure() || master.isFailure()) throw new Error('expected success')
    expect(subscriber.value).not.toBe(master.value)
  })

  it('routes reads to the replica once one is configured', async () => {
    const manager = await connected({ replicaUrls: [REPLICA_URL] })

    const reader = manager.reader()
    const master = manager.master()

    if (reader.isFailure() || master.isFailure()) throw new Error('expected success')
    expect(reader.value).not.toBe(master.value)
    expect(manager.replicas()).toHaveLength(1)
  })

  /*
   * The routing table's whole point, proved by the server rather than by inspection: a write that
   * reached the replica would come back as READONLY. Every write path asks for master() by name,
   * so this error is the thing that must never appear in the other integration files.
   */
  it('proves the replica would refuse a write, which is why writes never go there', async () => {
    const replica = new Redis(REPLICA_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })

    try {
      await replica.connect()
      await expect(replica.set('ruguin-test:readonly-probe', '1')).rejects.toThrow(/READONLY/u)
    } finally {
      await replica.quit()
    }
  })
})
```

- [ ] **Step 3: Escrever os testes de chave-valor**

```ts
// packages/cache/src/infra/drivers/valkey/operations/__tests__/key-value.operations.int.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type ICacheProvider } from '../../../../../domain'
import { createValkeyCache, sleep, uniquePrefix } from '../../__tests__/valkey-test-context'

const NAMESPACE = 'user'

/*
 * A holder rather than a bare `let`: the suite needs one connection shared by every case, and
 * reassigning a module-level binding from inside beforeAll is exactly what this repo's lint
 * refuses. `cache()` also fails loudly if a case ever runs before the hook.
 */
const context: { provider: ICacheProvider | null } = { provider: null }

const cache = (): ICacheProvider => {
  if (context.provider === null) throw new Error('the provider was never connected')

  return context.provider
}

beforeAll(async () => {
  const provider = createValkeyCache({ prefix: uniquePrefix({ label: 'key-value' }) }).provider

  const connected = await provider.connect()
  if (connected.isFailure()) throw new Error(connected.value.message)

  context.provider = provider
})

afterAll(async () => {
  await cache().disconnect()
})

describe('key-value operations against a live Valkey', () => {
  it('round-trips a value', async () => {
    await cache().set({ key: 'round-trip', namespace: NAMESPACE, value: { id: '1', name: 'ada' } })

    const read = await cache().get<{ id: string; name: string }>({ key: 'round-trip', namespace: NAMESPACE })

    if (read.isFailure()) throw new Error('expected success')
    expect(read.value).toEqual({ found: true, value: { id: '1', name: 'ada' } })
  })

  it('misses on a key that was never written', async () => {
    const read = await cache().get({ key: 'never-written', namespace: NAMESPACE })

    if (read.isFailure()) throw new Error('expected success')
    expect(read.value).toEqual({ found: false, value: null })
  })

  /*
   * The one thing a mock cannot prove. PX is the only reason an unbounded cache does not grow
   * until eviction starts, and an off-by-a-thousand on the unit would only show up in production
   * as memory that never comes back.
   */
  it('actually expires a key when its TTL elapses', async () => {
    await cache().set({ key: 'short-lived', namespace: NAMESPACE, ttlInMs: 150, value: 'gone soon' })

    const immediately = await cache().get<string>({ key: 'short-lived', namespace: NAMESPACE })
    if (immediately.isFailure()) throw new Error('expected success')
    expect(immediately.value.found).toBe(true)

    await sleep(250)

    const later = await cache().get<string>({ key: 'short-lived', namespace: NAMESPACE })
    if (later.isFailure()) throw new Error('expected success')
    expect(later.value.found).toBe(false)
  })

  it('reports the expiry it asked the server for', async () => {
    const before: number = Date.now()

    const stored = await cache().set({ key: 'expires-at', namespace: NAMESPACE, ttlInMs: 30_000, value: 1 })

    if (stored.isFailure()) throw new Error('expected success')
    expect(stored.value.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 30_000)
  })

  // SET NX: the second caller is told the key was already there, which is idempotency, not failure.
  it('stores only the first setIfNotExists for a key', async () => {
    const first = await cache().setIfNotExists({ key: 'once', namespace: NAMESPACE, ttlInMs: 30_000, value: 'a' })
    const second = await cache().setIfNotExists({ key: 'once', namespace: NAMESPACE, ttlInMs: 30_000, value: 'b' })

    if (first.isFailure() || second.isFailure()) throw new Error('expected success')
    expect(first.value.stored).toBe(true)
    expect(second.value.stored).toBe(false)

    const read = await cache().get<string>({ key: 'once', namespace: NAMESPACE })
    if (read.isFailure()) throw new Error('expected success')
    expect(read.value.value).toBe('a')
  })

  it('reports whether a delete removed anything', async () => {
    await cache().set({ key: 'doomed', namespace: NAMESPACE, value: 1 })

    const first = await cache().delete({ key: 'doomed', namespace: NAMESPACE })
    const second = await cache().delete({ key: 'doomed', namespace: NAMESPACE })

    if (first.isFailure() || second.isFailure()) throw new Error('expected success')
    expect(first.value.existed).toBe(true)
    expect(second.value.existed).toBe(false)
  })

  /*
   * After a deploy changes a type's shape the cache still holds the old JSON, and the cast to T
   * lies. `validate` turns that into a miss so the loader refills it, instead of a bug that only
   * reproduces on instances warm from before the deploy.
   */
  it('treats a value that fails validation as a miss, not as an error', async () => {
    await cache().set({ key: 'stale-shape', namespace: NAMESPACE, value: { legacy: true } })

    const read = await cache().get<{ id: string }>({
      key: 'stale-shape',
      namespace: NAMESPACE,
      validate: (value) => typeof value === 'object' && value !== null && 'id' in value
    })

    if (read.isFailure()) throw new Error('expected success')
    expect(read.value).toEqual({ found: false, value: null })
  })

  // null is a value, not an absence: this is what makes negative caching possible at all.
  it('distinguishes a stored null from a missing key', async () => {
    await cache().set({ key: 'explicit-null', namespace: NAMESPACE, value: null })

    const read = await cache().get<string>({ key: 'explicit-null', namespace: NAMESPACE })

    if (read.isFailure()) throw new Error('expected success')
    expect(read.value).toEqual({ found: true, value: null })
  })
})
```

- [ ] **Step 4: Escrever os testes de lock**

```ts
// packages/cache/src/infra/drivers/valkey/operations/__tests__/lock.operations.int.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type ICacheProvider } from '../../../../../domain'
import { createValkeyCache, uniquePrefix } from '../../__tests__/valkey-test-context'

const NAMESPACE = 'job'

/*
 * A holder rather than a bare `let`: the suite needs one connection shared by every case, and
 * reassigning a module-level binding from inside beforeAll is exactly what this repo's lint
 * refuses. `cache()` also fails loudly if a case ever runs before the hook.
 */
const context: { provider: ICacheProvider | null } = { provider: null }

const cache = (): ICacheProvider => {
  if (context.provider === null) throw new Error('the provider was never connected')

  return context.provider
}

beforeAll(async () => {
  const provider = createValkeyCache({ prefix: uniquePrefix({ label: 'lock' }) }).provider

  const connected = await provider.connect()
  if (connected.isFailure()) throw new Error(connected.value.message)

  context.provider = provider
})

afterAll(async () => {
  await cache().disconnect()
})

describe('lock operations against a live Valkey', () => {
  // SET NX PX: the semantics the whole lock rests on, and the one thing a mock would just assert.
  it('lets exactly one caller hold a key', async () => {
    const first = await cache().acquire({ key: 'exclusive', namespace: NAMESPACE, ttlInMs: 5000 })
    const second = await cache().acquire({ key: 'exclusive', namespace: NAMESPACE, ttlInMs: 5000 })

    if (first.isFailure()) throw new Error('expected the first acquire to succeed')
    if (second.isSuccess()) throw new Error('expected the second acquire to fail')
    expect(second.value.name).toBe('LockNotAcquiredError')

    await cache().release({ key: 'exclusive', namespace: NAMESPACE, token: first.value.token })
  })

  it('hands out a different token per acquisition', async () => {
    const first = await cache().acquire({ key: 'token-a', namespace: NAMESPACE, ttlInMs: 5000 })
    const second = await cache().acquire({ key: 'token-b', namespace: NAMESPACE, ttlInMs: 5000 })

    if (first.isFailure() || second.isFailure()) throw new Error('expected success')
    expect(first.value.token).not.toBe(second.value.token)
  })

  /*
   * The compare-and-swap, proved by the server. A blind DEL here would let a process whose lock
   * already expired delete the lock a *different* process took after it — two owners at once, and
   * no error anywhere to say so.
   */
  it('refuses to release a lock held by someone else, and leaves it held', async () => {
    const held = await cache().acquire({ key: 'guarded', namespace: NAMESPACE, ttlInMs: 5000 })
    if (held.isFailure()) throw new Error('expected success')

    const stolen = await cache().release({ key: 'guarded', namespace: NAMESPACE, token: 'not-the-owner' })

    if (stolen.isSuccess()) throw new Error('expected failure')
    expect(stolen.value.name).toBe('LockNotOwnedError')

    const contender = await cache().acquire({ key: 'guarded', namespace: NAMESPACE, ttlInMs: 5000 })
    expect(contender.isFailure()).toBe(true)

    await cache().release({ key: 'guarded', namespace: NAMESPACE, token: held.value.token })
  })

  it('frees the key once the owner releases it', async () => {
    const held = await cache().acquire({ key: 'handover', namespace: NAMESPACE, ttlInMs: 5000 })
    if (held.isFailure()) throw new Error('expected success')

    const released = await cache().release({ key: 'handover', namespace: NAMESPACE, token: held.value.token })
    if (released.isFailure()) throw new Error('expected success')
    expect(released.value.released).toBe(true)

    const next = await cache().acquire({ key: 'handover', namespace: NAMESPACE, ttlInMs: 5000 })
    expect(next.isSuccess()).toBe(true)
  })

  it('refuses to extend a lock held by someone else', async () => {
    const held = await cache().acquire({ key: 'extendable', namespace: NAMESPACE, ttlInMs: 5000 })
    if (held.isFailure()) throw new Error('expected success')

    const stolen = await cache().extend({
      key: 'extendable',
      namespace: NAMESPACE,
      token: 'not-the-owner',
      ttlInMs: 60_000
    })

    if (stolen.isSuccess()) throw new Error('expected failure')
    expect(stolen.value.name).toBe('LockNotOwnedError')
  })

  it('extends a lock for its owner', async () => {
    const held = await cache().acquire({ key: 'renewed', namespace: NAMESPACE, ttlInMs: 1000 })
    if (held.isFailure()) throw new Error('expected success')

    const extended = await cache().extend({
      key: 'renewed',
      namespace: NAMESPACE,
      token: held.value.token,
      ttlInMs: 60_000
    })

    if (extended.isFailure()) throw new Error('expected success')
    expect(extended.value.expiresAt.getTime()).toBeGreaterThan(held.value.expiresAt.getTime())
  })

  /*
   * The budget is spent against a real clock, not converted into an attempt count: this waits
   * out a lock that expires on its own, which is precisely the case a "give up after N tries"
   * driver would abandon early or overshoot.
   */
  it('waits within its budget for a lock that expires on its own', async () => {
    const doomed = await cache().acquire({ key: 'queued', namespace: NAMESPACE, ttlInMs: 200 })
    if (doomed.isFailure()) throw new Error('expected success')

    const queued = await cache().acquire({
      key: 'queued',
      namespace: NAMESPACE,
      ttlInMs: 5000,
      wait: { pollIntervalInMs: 25, timeoutInMs: 2000 }
    })

    expect(queued.isSuccess()).toBe(true)
  })

  it('gives up when the budget runs out, and says how many attempts it made', async () => {
    const held = await cache().acquire({ key: 'contended', namespace: NAMESPACE, ttlInMs: 30_000 })
    if (held.isFailure()) throw new Error('expected success')

    const queued = await cache().acquire({
      key: 'contended',
      namespace: NAMESPACE,
      ttlInMs: 5000,
      wait: { pollIntervalInMs: 25, timeoutInMs: 150 }
    })

    if (queued.isSuccess()) throw new Error('expected failure')
    expect(queued.value.message).toMatch(/attempt/u)
  })

  // Locks carry no version segment, so an invalidateNamespace mid-hold cannot orphan the key.
  it('keeps a held lock reachable across an invalidateNamespace', async () => {
    const held = await cache().acquire({ key: 'survivor', namespace: NAMESPACE, ttlInMs: 30_000 })
    if (held.isFailure()) throw new Error('expected success')

    await cache().invalidateNamespace({ namespace: NAMESPACE })

    const released = await cache().release({ key: 'survivor', namespace: NAMESPACE, token: held.value.token })

    if (released.isFailure()) throw new Error('expected success')
    expect(released.value.released).toBe(true)
  })
})
```

- [ ] **Step 5: Escrever os testes de health check**

```ts
// packages/cache/src/infra/drivers/valkey/operations/__tests__/health.operations.int.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CacheDriver, CacheHealthStatus, type ICacheProvider } from '../../../../../domain'
import { createValkeyCache, REPLICA_URL, uniquePrefix } from '../../__tests__/valkey-test-context'

/*
 * A holder rather than a bare `let`: the suite needs one connection shared by every case, and
 * reassigning a module-level binding from inside beforeAll is exactly what this repo's lint
 * refuses. `cache()` also fails loudly if a case ever runs before the hook.
 */
const context: { provider: ICacheProvider | null } = { provider: null }

const cache = (): ICacheProvider => {
  if (context.provider === null) throw new Error('the provider was never connected')

  return context.provider
}

beforeAll(async () => {
  const provider = createValkeyCache({
    prefix: uniquePrefix({ label: 'health' }),
    replicaUrls: [REPLICA_URL]
  }).provider

  const connected = await provider.connect()
  if (connected.isFailure()) throw new Error(connected.value.message)

  context.provider = provider
})

afterAll(async () => {
  await cache().disconnect()
})

describe('health check against a live Valkey', () => {
  it('reports the master as reachable and in the master role', async () => {
    const health = await cache().healthCheck()

    if (health.isFailure()) throw new Error('expected success')
    expect(health.value.driver).toBe(CacheDriver.VALKEY)
    expect(health.value.master.reachable).toBe(true)
    expect(health.value.master.role).toBe('master')
    expect(health.value.master.latencyInMs).toBeGreaterThanOrEqual(0)
  })

  it('reads the server identity out of INFO', async () => {
    const health = await cache().healthCheck()

    if (health.isFailure()) throw new Error('expected success')
    expect(health.value.server.version).toMatch(/^\d+\.\d+/u)
    expect(health.value.server.uptimeInSeconds).toBeGreaterThan(0)
  })

  /*
   * The local instance runs with maxmemory:0, so the percentage has to be null. A 0 here would
   * read as "plenty of room" and disarm the pressure check on every instance that never sets a
   * limit — which is all of them, locally.
   */
  it('reports no memory percentage while maxmemory is unlimited', async () => {
    const health = await cache().healthCheck()

    if (health.isFailure()) throw new Error('expected success')
    expect(health.value.memory.usedBytes).toBeGreaterThan(0)
    expect(health.value.memory.maxBytes).toBeNull()
    expect(health.value.memory.usedPercentage).toBeNull()
    expect(health.value.memory.evictedKeys).toBeGreaterThanOrEqual(0)
  })

  it('reads the client counters, including the ones that only matter before an incident', async () => {
    const health = await cache().healthCheck()

    if (health.isFailure()) throw new Error('expected success')
    expect(health.value.clients.connected).toBeGreaterThan(0)
    expect(health.value.clients.blocked).toBeGreaterThanOrEqual(0)
    expect(health.value.clients.rejectedTotal).toBeGreaterThanOrEqual(0)
  })

  it('probes the replica and measures how far behind it is', async () => {
    const health = await cache().healthCheck()

    if (health.isFailure()) throw new Error('expected success')
    expect(health.value.replicas).toHaveLength(1)

    const replica = health.value.replicas[0]
    expect(replica?.reachable).toBe(true)
    expect(replica?.replicationLagInBytes).not.toBeNull()
  })

  it('reports healthy when master and replica are both in step', async () => {
    const health = await cache().healthCheck()

    if (health.isFailure()) throw new Error('expected success')
    expect(health.value.status).toBe(CacheHealthStatus.HEALTHY)
  })

  it('skips the replicas when the caller asks it to', async () => {
    const health = await cache().healthCheck({ includeReplicas: false })

    if (health.isFailure()) throw new Error('expected success')
    expect(health.value.replicas).toEqual([])
  })

  /*
   * The only Either failure this contract admits. Everything else — an unreachable master
   * included — is a *reported* status, because "the cache is down" is the answer the caller asked
   * for, not a failure to answer.
   */
  it('fails only when called before connect(), which is a programming error', async () => {
    const fresh = createValkeyCache({ prefix: uniquePrefix({ label: 'health-cold' }) }).provider

    const health = await fresh.healthCheck()

    if (health.isSuccess()) throw new Error('expected failure')
    expect(health.value.name).toBe('CacheNotInitializedError')
  })
})
```

- [ ] **Step 6: Escrever os testes do driver completo**

Cobre os tres cenarios que a spec §12 destaca — modo forte enxerga a invalidacao na hora, modo eventual respeita o teto, broadcast encurta a janela — mais o ciclo de cache-aside, contadores, scores e exclusao mutua.

```ts
// packages/cache/src/infra/drivers/valkey/__tests__/valkey-cache.driver.int.ts
import { success } from '@ruguin/utils'
import { afterEach, describe, expect, it } from 'vitest'

import { CacheConsistency, CacheLockOutcome, CacheSource, type ICacheProvider } from '../../../../domain'

import { createValkeyCache, sleep, uniquePrefix } from './valkey-test-context'

const NAMESPACE = 'user'

const open: ICacheProvider[] = []

const connect = async (input: Parameters<typeof createValkeyCache>[0]): Promise<ICacheProvider> => {
  const { provider } = createValkeyCache(input)
  open.push(provider)

  const connected = await provider.connect()
  if (connected.isFailure()) throw new Error(connected.value.message)

  return provider
}

afterEach(async () => {
  const closing: readonly ICacheProvider[] = [...open]
  open.length = 0

  await Promise.all(closing.map(async (provider) => provider.disconnect()))
})

describe('namespace invalidation against a live Valkey', () => {
  /*
   * Nothing is deleted: the version moves and the old keys become unreachable, which is what makes
   * bulk invalidation O(1) and keeps SCAN out of the package entirely.
   */
  it('makes every key in the namespace unreachable without deleting anything', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'invalidate' }) })

    await provider.set({ key: 'a', namespace: NAMESPACE, value: 1 })
    await provider.set({ key: 'b', namespace: NAMESPACE, value: 2 })

    const bumped = await provider.invalidateNamespace({ namespace: NAMESPACE })
    if (bumped.isFailure()) throw new Error('expected success')
    expect(bumped.value.version).toBe(2)

    const readA = await provider.get({ key: 'a', namespace: NAMESPACE })
    const readB = await provider.get({ key: 'b', namespace: NAMESPACE })

    if (readA.isFailure() || readB.isFailure()) throw new Error('expected success')
    expect(readA.value.found).toBe(false)
    expect(readB.value.found).toBe(false)
  })

  // Absent means version 1, so a bump has to land on 2 — a plain INCR would answer 1 and change nothing.
  it('advances the version even when the namespace was never invalidated before', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'first-bump' }) })

    const before = await provider.resolveNamespaceVersion({ namespace: NAMESPACE })
    const bumped = await provider.invalidateNamespace({ namespace: NAMESPACE })

    if (before.isFailure() || bumped.isFailure()) throw new Error('expected success')
    expect(before.value.version).toBe(1)
    expect(bumped.value.version).toBe(2)
  })

  it('leaves other namespaces untouched', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'scoped' }) })

    await provider.set({ key: 'a', namespace: NAMESPACE, value: 1 })
    await provider.set({ key: 'a', namespace: 'session', value: 2 })

    await provider.invalidateNamespace({ namespace: NAMESPACE })

    const survivor = await provider.get<number>({ key: 'a', namespace: 'session' })

    if (survivor.isFailure()) throw new Error('expected success')
    expect(survivor.value).toEqual({ found: true, value: 2 })
  })
})

describe('consistency modes across two instances', () => {
  /*
   * The scenario that motivated §4 of the spec. Two providers on the same Valkey, so instance B
   * has its own memo and cannot see A's invalidation until something tells it — which is exactly
   * the window strong mode exists to close.
   */
  it('lets a strong read see another instance invalidation immediately', async () => {
    const prefix: string = uniquePrefix({ label: 'strong' })
    const writer = await connect({ prefix })
    const reader = await connect({
      namespaces: { [NAMESPACE]: { consistency: CacheConsistency.STRONG } },
      namespaceVersionLocalTtlInMs: 60_000,
      prefix
    })

    await writer.set({ key: 'a', namespace: NAMESPACE, value: 'first' })

    const warm = await reader.get<string>({ key: 'a', namespace: NAMESPACE })
    if (warm.isFailure()) throw new Error('expected success')
    expect(warm.value).toEqual({ found: true, value: 'first' })

    await writer.invalidateNamespace({ namespace: NAMESPACE })

    const afterInvalidation = await reader.get<string>({ key: 'a', namespace: NAMESPACE })

    if (afterInvalidation.isFailure()) throw new Error('expected success')
    expect(afterInvalidation.value.found).toBe(false)
  })

  /*
   * The other half of the trade. With the broadcast off, the memo TTL is the only thing that ends
   * the window — so an eventual reader is allowed to serve the old value, but never past the
   * ceiling. Both halves of that promise are asserted here.
   */
  it('lets an eventual read serve a stale value, but never past the memo ttl', async () => {
    const prefix: string = uniquePrefix({ label: 'eventual' })
    const writer = await connect({ invalidationBroadcast: false, prefix })
    const reader = await connect({ invalidationBroadcast: false, namespaceVersionLocalTtlInMs: 300, prefix })

    await writer.set({ key: 'a', namespace: NAMESPACE, value: 'first' })

    const warm = await reader.get<string>({ key: 'a', namespace: NAMESPACE })
    if (warm.isFailure()) throw new Error('expected success')
    expect(warm.value.found).toBe(true)

    await writer.invalidateNamespace({ namespace: NAMESPACE })

    const stale = await reader.get<string>({ key: 'a', namespace: NAMESPACE })
    if (stale.isFailure()) throw new Error('expected success')
    expect(stale.value.value).toBe('first')

    await sleep(400)

    const expired = await reader.get<string>({ key: 'a', namespace: NAMESPACE })
    if (expired.isFailure()) throw new Error('expected success')
    expect(expired.value.found).toBe(false)
  })

  /*
   * Best-effort, and that is the point: the broadcast does not replace the TTL, it shortens the
   * typical window from seconds to milliseconds. The memo ttl here is a minute, so a miss inside
   * two seconds can only have come from a message.
   */
  it('shortens the eventual window to milliseconds when the broadcast is on', async () => {
    const prefix: string = uniquePrefix({ label: 'broadcast' })
    const writer = await connect({ invalidationBroadcast: true, namespaceVersionLocalTtlInMs: 60_000, prefix })
    const reader = await connect({ invalidationBroadcast: true, namespaceVersionLocalTtlInMs: 60_000, prefix })

    await writer.set({ key: 'a', namespace: NAMESPACE, value: 'first' })

    const warm = await reader.get<string>({ key: 'a', namespace: NAMESPACE })
    if (warm.isFailure()) throw new Error('expected success')
    expect(warm.value.found).toBe(true)

    await writer.invalidateNamespace({ namespace: NAMESPACE })

    let wasMissed = false
    for (let attempt = 0; !wasMissed && attempt < 40; attempt += 1) {
      await sleep(50)

      const read = await reader.get<string>({ key: 'a', namespace: NAMESPACE })
      if (read.isFailure()) throw new Error('expected success')
      wasMissed = !read.value.found
    }

    expect(wasMissed).toBe(true)
  })
})

describe('cache-aside against a live Valkey', () => {
  it('loads on a miss, then serves the second call from the cache', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'get-or-set' }) })

    let loads = 0
    const loader = (): Promise<ReturnType<typeof success<Error, number>>> => {
      loads += 1

      return Promise.resolve(success(42))
    }

    const first = await provider.getOrSet<number, Error>({ key: 'a', loader, namespace: NAMESPACE })
    const second = await provider.getOrSet<number, Error>({ key: 'a', loader, namespace: NAMESPACE })

    if (first.isFailure() || second.isFailure()) throw new Error('expected success')
    expect(first.value.source).toBe(CacheSource.LOADER)
    expect(second.value.source).toBe(CacheSource.CACHE)
    expect(second.value.value).toBe(42)
    expect(loads).toBe(1)
  })

  /*
   * A loader that answers null is not a failure, it is the negative-cache case: the sentinel is
   * stored so a repeatedly-missing row does not hammer the database once per request.
   */
  it('caches a null answer so a missing row is not looked up twice', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'negative' }) })

    let loads = 0
    const loader = (): Promise<ReturnType<typeof success<Error, number | null>>> => {
      loads += 1

      return Promise.resolve(success(null))
    }

    await provider.getOrSet<number, Error>({ key: 'ghost', loader, namespace: NAMESPACE })
    const second = await provider.getOrSet<number, Error>({ key: 'ghost', loader, namespace: NAMESPACE })

    if (second.isFailure()) throw new Error('expected success')
    expect(second.value.source).toBe(CacheSource.CACHE)
    expect(second.value.value).toBeNull()
    expect(loads).toBe(1)
  })

  it('acquires the fill lock when asked, and says so', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'stampede' }) })

    const loaded = await provider.getOrSet<number, Error>({
      key: 'a',
      loader: () => Promise.resolve(success(1)),
      lock: { enabled: true },
      namespace: NAMESPACE
    })

    if (loaded.isFailure()) throw new Error('expected success')
    expect(loaded.value.lockOutcome).toBe(CacheLockOutcome.ACQUIRED)
  })

  // forceRefresh is a refresh, not a bypass: the loader runs and the cache is rewritten.
  it('rewrites the cache on a forced refresh', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'refresh' }) })

    await provider.getOrSet<number, Error>({
      key: 'a',
      loader: () => Promise.resolve(success(1)),
      namespace: NAMESPACE
    })

    const refreshed = await provider.getOrSet<number, Error>({
      forceRefresh: true,
      key: 'a',
      loader: () => Promise.resolve(success(2)),
      namespace: NAMESPACE
    })

    if (refreshed.isFailure()) throw new Error('expected success')
    expect(refreshed.value.source).toBe(CacheSource.LOADER)

    const read = await provider.get<number>({ key: 'a', namespace: NAMESPACE })
    if (read.isFailure()) throw new Error('expected success')
    expect(read.value.value).toBe(2)
  })
})

describe('counters and scores against a live Valkey', () => {
  /*
   * Fixed window, anchored to the first increment. Renewing on every call would produce a counter
   * that never resets under sustained traffic — a rate limit that latches shut for good.
   */
  it('anchors the counter window to the first increment', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'counter' }) })

    await provider.increment({ key: 'hits', namespace: 'rate', windowInMs: 250 })
    await sleep(120)
    await provider.increment({ key: 'hits', namespace: 'rate', windowInMs: 250 })

    const during = await provider.getCounter({ key: 'hits', namespace: 'rate' })
    if (during.isFailure()) throw new Error('expected success')
    expect(during.value.value).toBe(2)

    await sleep(200)

    const after = await provider.getCounter({ key: 'hits', namespace: 'rate' })
    if (after.isFailure()) throw new Error('expected success')
    expect(after.value.value).toBe(0)
  })

  it('counts up and down', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'counter-updown' }) })

    await provider.increment({ by: 5, key: 'balance', namespace: 'rate' })
    const after = await provider.decrement({ by: 2, key: 'balance', namespace: 'rate' })

    if (after.isFailure()) throw new Error('expected success')
    expect(after.value.value).toBe(3)
  })

  it('ranks members and reports the size of the set alongside the position', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'score' }) })

    await provider.setScore({ key: 'weekly', member: 'ada', namespace: 'board', score: 10 })
    await provider.setScore({ key: 'weekly', member: 'grace', namespace: 'board', score: 30 })
    await provider.setScore({ key: 'weekly', member: 'alan', namespace: 'board', score: 20 })

    const rank = await provider.getRank({ key: 'weekly', member: 'alan', namespace: 'board' })
    const top = await provider.getTopScores({ key: 'weekly', limit: 2, namespace: 'board' })
    const total = await provider.countScores({ key: 'weekly', namespace: 'board' })

    if (rank.isFailure() || top.isFailure() || total.isFailure()) throw new Error('expected success')
    expect(rank.value).toEqual({ rank: 2, total: 3 })
    expect(top.value.entries).toEqual([
      { member: 'grace', score: 30 },
      { member: 'alan', score: 20 }
    ])
    expect(total.value.total).toBe(3)
  })

  it('answers a null rank for a member that is not in the set', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'score-missing' }) })

    await provider.setScore({ key: 'weekly', member: 'ada', namespace: 'board', score: 10 })

    const rank = await provider.getRank({ key: 'weekly', member: 'nobody', namespace: 'board' })

    if (rank.isFailure()) throw new Error('expected success')
    expect(rank.value).toEqual({ rank: null, total: 1 })
  })

  it('increments and removes a member score', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'score-mutate' }) })

    await provider.setScore({ key: 'weekly', member: 'ada', namespace: 'board', score: 10 })
    const bumped = await provider.incrementScore({ by: 5, key: 'weekly', member: 'ada', namespace: 'board' })
    const removed = await provider.removeScore({ key: 'weekly', member: 'ada', namespace: 'board' })
    const missing = await provider.getScore({ key: 'weekly', member: 'ada', namespace: 'board' })

    if (bumped.isFailure() || removed.isFailure() || missing.isFailure()) throw new Error('expected success')
    expect(bumped.value.score).toBe(15)
    expect(removed.value.removed).toBe(true)
    expect(missing.value.score).toBeNull()
  })
})

describe('mutual exclusion against a live Valkey', () => {
  it('runs the task under the lock and releases it afterwards', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'execute-with-lock' }) })

    const executed = await provider.executeWithLock<string, Error>({
      key: 'job-1',
      namespace: 'job',
      task: () => Promise.resolve(success('done')),
      ttlInMs: 5000
    })

    if (executed.isFailure()) throw new Error('expected success')
    expect(executed.value.value).toBe('done')

    const reacquired = await provider.acquire({ key: 'job-1', namespace: 'job', ttlInMs: 1000 })
    expect(reacquired.isSuccess()).toBe(true)
  })

  /*
   * The one operation that deliberately refuses to fail open: the caller asked for exclusion, so
   * not getting it has to be a failure rather than a task that runs anyway.
   */
  it('refuses to run the task when the lock is already held', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'execute-contended' }) })

    const held = await provider.acquire({ key: 'job-2', namespace: 'job', ttlInMs: 30_000 })
    if (held.isFailure()) throw new Error('expected success')

    let didRun = false
    const executed = await provider.executeWithLock<string, Error>({
      key: 'job-2',
      namespace: 'job',
      task: () => {
        didRun = true

        return Promise.resolve(success('done'))
      },
      ttlInMs: 5000
    })

    if (executed.isSuccess()) throw new Error('expected failure')
    expect(didRun).toBe(false)
  })
})
```

- [ ] **Step 7: Rodar a suite de integracao**

```bash
docker compose -f infrastructure/local/docker-compose.yml up -d redis redis-replica
pnpm --filter @ruguin/cache test:integration
```

Expected: PASS. Se `probes the replica and measures how far behind it is` falhar com `replicas: []`, a replica nao subiu — confira a Task 1, Step 3.

- [ ] **Step 8: Rodar tudo**

Run: `pnpm --filter @ruguin/cache test:all && pnpm --filter @ruguin/cache check:types && pnpm --filter @ruguin/cache check:lint`
Expected: PASS nos tres.

- [ ] **Step 9: Atualizar o CLAUDE.md do pacote**

Em `packages/cache/CLAUDE.md`, na secao `## Purpose`, troque ``memory`e`noop`ship today,`valkey` is a future plan` por `all three drivers ship today`. Na arvore de `## Structure`, dentro de `drivers/`, acrescente:

```text
      valkey/     # iovalkey: master + replicas + a dedicated subscriber connection
```

E abaixo de `serializers/json-serializer.strategy.ts`, no mesmo bloco:

```text
    decorators/   # observable(resilient(driver)) — spans and circuit breaker over ICacheDriver
  factory/
    cache.factory.ts   # the single composition root: picks the driver, applies the decorators
```

Em `## Rules`, acrescente:

```markdown
- O driver `valkey` mantem tres conexoes: master, uma por replica, e uma dedicada ao subscriber
  de invalidacao — um cliente em modo subscribe recusa comandos normais. Leitura eventual vai a
  replica (round-robin, com fallback para o master); leitura forte, escrita, contador (inclusive
  na leitura) e lock vao sempre ao master.
- Os decorators envolvem `ICacheDriver`, nao `ICacheProvider`. E isso que faz o `getOrSet`
  enxergar o breaker: circuito aberto vira miss instantaneo e o cache-aside vai ao loader sem
  pagar timeout.
```

Em `## Commands`, acrescente:

```bash
pnpm --filter @ruguin/cache test:integration   # exige docker compose up -d redis redis-replica
```

- [ ] **Step 10: Commit**

```bash
git add packages/cache
git commit -m "test(cache): add valkey integration tests covering routing, locks and consistency"
```

---

## Verificacao final

- [ ] `pnpm --filter @ruguin/cache check:types` — sem erro.
- [ ] `pnpm --filter @ruguin/cache check:lint` — sem erro e sem warning.
- [ ] `pnpm --filter @ruguin/cache test:unit` — verde sem Docker.
- [ ] `pnpm --filter @ruguin/cache test:integration` — verde com `redis` e `redis-replica` no ar.
- [ ] `docker exec ruguin-redis-replica-1 valkey-cli set probe 1` responde `READONLY ...` — a replica continua sendo replica.

## Decisoes tomadas neste plano que a spec nao cobre

| Decisao                                                  | Motivo                                                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Quarto script Lua (`BUMP_NAMESPACE_VERSION_SCRIPT`)      | `INCR` numa chave ausente devolve 1, e ausente ja significa versao 1 — a primeira invalidacao nao invalidaria nada                       |
| Scripts Lua como constantes TypeScript                   | O pacote nao tem build; um `.lua` nao seria copiado para lugar nenhum e ler do disco trocaria erro de compilacao por `ENOENT` em runtime |
| `@opentelemetry/api` como dependencia, nao peer          | O Decorator sai pelo barrel raiz, entao todo consumidor carrega o import                                                                 |
| `InvalidCacheConfigError`                                | A factory recebe config crua e precisa recusar `valkey` sem master URL fora do caminho do `@ruguin/env`                                  |
| `CacheFactory` como objeto `as const`                    | `@typescript-eslint/no-extraneous-class` recusa classe so com estaticos; a API `CacheFactory.create(...)` fica igual                     |
| `factory/create-valkey-driver.ts` separado               | A familia Valkey tem onze colaboradores; inline soterraria a selecao de driver                                                           |
| `healthCheck` / `connect` / `disconnect` fora do breaker | Curto-circuitar o health faria o breaker esconder a queda a que reage                                                                    |
| `invalidateNamespace` sempre vai ao servidor             | Responder "invalidado" sem invalidar e a unica mentira que o fail-open nao pode contar                                                   |
| Payload corrompido nao e apagado no driver Valkey        | Deletar seria escrita no caminho de leitura, e escrita exige o master — a conexao de que a leitura eventual foge                         |
| `effectiveConsistency` publico no resolver               | A cascata escolhe o no do comando, nao so o da versao                                                                                    |
| `NamespaceVersionSource` falha com `CacheOperationError` | Namespace invalido e `InvalidCacheKeyError`; espremer em `CacheConnectionError` mentiria sobre a causa                                   |
