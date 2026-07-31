# `@ruguin/cache` — Pacote de cache (Valkey, cache-aside, lock distribuído) — Design

**Data:** 2026-07-31
**Escopo:** novo `packages/cache`, ajustes em `packages/env`, integração em `apps/core-server`

## Contexto

O monorepo já sobe um Valkey (`infrastructure/local/docker-compose.yml`, serviço `redis`, imagem `valkey/valkey:9-alpine`), mas nenhum código o consome. O `packages/env` já tem um `cache.environment.ts` commitado que antecipa um pacote de cache — com prefixo, driver, TTL padrão, jitter, TTL negativo e TTL local de versão de namespace — porém sem nenhuma variável de conexão e com um enum de driver que hoje **rejeita explicitamente** o valor `valkey` (afirmado em `packages/env/src/packages/__tests__/cache.environment.unit.ts:60`).

O `apps/core-server` é NestJS 11 com adapter Fastify, já tem `@nestjs/terminus` como dependência, e seu `HealthController` chama `this.health.check([])` — uma lista de indicadores vazia.

O `docs/ddd-naming-guide.md` §3.2 já prevê um `RateLimiterProvider` sobre Redis no futuro `dispatch-worker`, o que confirma que este pacote precisa nascer reutilizável por mais de um serviço, e não acoplado ao NestJS.

## Objetivo

Criar `@ruguin/cache`: um pacote em Clean Architecture que expõe operações de cache (chave-valor, contador, idempotência, lock distribuído, score/ranking, health check) através de contratos granulares no domínio, com implementações intercambiáveis por driver (`valkey`, `memory`, `noop`), cache-aside com proteção contra stampede, invalidação em massa O(1) com dois modos de consistência, e um adapter NestJS opcional. Ao final, `GET /health` do `core-server` reporta o estado real do Valkey.

## Fora de escopo

- **Cluster mode / Sentinel do Valkey** — a topologia assumida é um master com réplicas de leitura opcionais. Redlock (quorum entre múltiplos masters independentes) não se aplica e não será implementado.
- **Serializers além de JSON** — `ISerializerStrategy` existe para permitir msgpack/outro depois; só `JsonSerializerStrategy` é implementado agora.
- **Pub/Sub, streams e filas como API pública** — este pacote é cache, não message broker (isso é `packages/message-broker`). Pub/Sub é usado **internamente** para o broadcast de invalidação de namespace (§4.3), mas nenhum contrato expõe publicação ou assinatura ao consumidor.
- **`deleteByPattern` / `SCAN`** — invalidação em massa é feita por versionamento de namespace (§4). Nenhuma API do pacote permite varrer o keyspace.
- **Cache de segundo nível em processo (near-cache)** — a única coisa cacheada em memória local é o número de versão do namespace (§4), com TTL próprio.
- **Métricas OpenTelemetry exportadas** — o Decorator de observabilidade (§7) emite spans via `@opentelemetry/api`, que o `core-server` já configura para traces. Export de _métricas_ (OTLPMetricExporter) segue fora de escopo, como já registrado em `2026-07-30-core-server-api-docs-design.md`.

## 1. Decisões de arquitetura

| Decisão                      | Escolha                           | Motivo                                                                                |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| Client                       | `iovalkey`                        | Fork oficial mantido pelo time do Valkey, API drop-in do ioredis                      |
| Topologia                    | master + réplicas opcionais       | Escritas e locks no master; leituras na réplica com fallback                          |
| Lock                         | single-master `SET NX PX` + token | Redlock exigiria múltiplos masters independentes, que não existem aqui                |
| Serialização                 | JSON via Strategy                 | Único formato necessário hoje; trocável sem tocar em chamador                         |
| TTL                          | opcional, com default do env      | `CACHE_DEFAULT_TTL_MS` já existe e é honrado; **exceto lock**, onde TTL é obrigatório |
| Invalidação em massa         | versionamento de namespace        | O(1); `SCAN` em produção é risco operacional                                          |
| Visibilidade da invalidação  | dois modos, em cascata            | `eventual` (rápido) por default; `strong` (sem janela) por namespace ou por chamada   |
| Falha do cache no `getOrSet` | fail-open                         | Cache é otimização; indisponibilidade não pode derrubar request                       |
| Testes de infra              | integração contra Valkey real     | Semântica de `SET NX PX`, TTL e Lua não se prova com mock                             |

### 1.1 Conciliação entre "provider único" e SOLID

O pacote expõe **os dois níveis** de granularidade, apontando para a mesma instância:

1. `domain/contracts/` mantém contratos granulares — uma interface por operação, com um método cada, no padrão já usado no monorepo (`IGenerateAccessTokenProvider` + namespace `...DTO`). Isso preserva **ISP**: um repositório que só lê cache injeta `IGetCacheProvider` e o mock do seu teste tem um método, não vinte e cinco.
2. `ICacheProvider` é uma interface **composta** (`extends` de todas as demais), para quem prefere injetar uma dependência só.
3. A implementação de cada driver é um **Facade** que delega para objetos de operação agrupados por concern — não uma god class. **SRP** vive nos internos; a conveniência vive no Facade.

### 1.2 Design patterns

| Pattern          | Onde                                  | Problema resolvido                                                                 |
| ---------------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| Facade           | `ICacheProvider` + `*CacheProvider`   | Todos os métodos em uma instância, sem god class                                   |
| Abstract Factory | `CacheFactory.create(config)`         | Seleciona a família de implementações por `CACHE_DRIVER`; única raiz de composição |
| Adapter          | `infra/drivers/*/`                    | Cada lib adaptada aos mesmos contratos de domínio                                  |
| Strategy         | `ISerializerStrategy`                 | Trocar formato de serialização sem tocar em chamador                               |
| Null Object      | `infra/drivers/noop/`                 | Desligar cache por config, sem `if (cacheEnabled)` espalhado                       |
| Decorator        | `infra/decorators/`                   | Observabilidade e resiliência sem modificar drivers (OCP)                          |
| Template Method  | executor compartilhado nas operations | Mapeamento uniforme de erro do client para erro de domínio                         |

## 2. Estrutura de arquivos

```text
packages/cache/src/
  domain/
    contracts/
      cache/
        get-cache.provider.ts                 IGetCacheProvider
        set-cache.provider.ts                 ISetCacheProvider
        delete-cache.provider.ts              IDeleteCacheProvider
        set-if-not-exists-cache.provider.ts   ISetIfNotExistsCacheProvider
        get-or-set-cache.provider.ts          IGetOrSetCacheProvider
      counter/
        increment-counter.provider.ts         IIncrementCounterProvider
        decrement-counter.provider.ts         IDecrementCounterProvider
        get-counter.provider.ts               IGetCounterProvider
      lock/
        acquire-lock.provider.ts              IAcquireLockProvider
        release-lock.provider.ts              IReleaseLockProvider
        extend-lock.provider.ts               IExtendLockProvider
        execute-with-lock.provider.ts         IExecuteWithLockProvider
      score/
        set-score.provider.ts                 ISetScoreProvider
        increment-score.provider.ts           IIncrementScoreProvider
        get-score.provider.ts                 IGetScoreProvider
        get-rank.provider.ts                  IGetRankProvider
        get-top-scores.provider.ts            IGetTopScoresProvider
        remove-score.provider.ts              IRemoveScoreProvider
        count-scores.provider.ts              ICountScoresProvider
      namespace/
        invalidate-namespace.provider.ts      IInvalidateNamespaceProvider
        resolve-namespace-version.provider.ts IResolveNamespaceVersionProvider
      connection/
        connect.provider.ts                   IConnectProvider
        disconnect.provider.ts                IDisconnectProvider
      health/
        health-check.provider.ts              IHealthCheckProvider
      serializer/
        serializer.strategy.ts                ISerializerStrategy
      cache.provider.ts                       ICacheProvider (composição)
      index.ts
    enums/
      cache-driver.enum.ts                    CacheDriver
      cache-health-status.enum.ts             CacheHealthStatus
      cache-source.enum.ts                    CacheSource
      cache-consistency.enum.ts               CacheConsistency ('eventual' | 'strong')
      index.ts
    errors/
      cache-connection.error.ts
      cache-timeout.error.ts
      cache-serialization.error.ts
      cache-not-initialized.error.ts
      invalid-cache-key.error.ts
      lock-not-acquired.error.ts
      lock-not-owned.error.ts
      index.ts
  application/
    get-or-set-cache.provider.ts              cache-aside (orquestra contratos)
    execute-with-lock.provider.ts             lock + callback + release no finally
  infra/
    drivers/
      valkey/
        valkey-cache.provider.ts              Facade, implementa ICacheProvider
        connection/
          valkey-connection.manager.ts        master + réplicas + subscriber, roteamento
        operations/
          key-value.operations.ts
          counter.operations.ts
          lock.operations.ts
          score.operations.ts
          namespace.operations.ts
          health.operations.ts
        invalidation/
          invalidation-publisher.ts           publica no canal após INCR
          invalidation-subscriber.ts          assina, atualiza memo, limpa tudo na reconexão
        scripts/
          release-lock.lua
          extend-lock.lua
          get-with-namespace-version.lua      leitura forte em 1 round-trip (§4.2)
      memory/
        memory-cache.provider.ts              Map + TTL simulado
      noop/
        noop-cache.provider.ts                Null Object
    serializers/
      json-serializer.strategy.ts
    decorators/
      observable-cache.provider.ts            spans OTel + contadores hit/miss
      resilient-cache.provider.ts             circuit breaker
    key-builder.ts                            monta e valida a chave final
    namespace-version.resolver.ts             cascata de consistência + memo local
  factory/
    cache.factory.ts                          CacheFactory
  nestjs/
    cache.module.ts                           forRoot / forRootAsync / isGlobal
    cache.tokens.ts                           Symbols de injeção
    inject-cache.decorator.ts                 @InjectCache()
    cache-health.indicator.ts                 HealthIndicator do Terminus
    index.ts
  index.ts
```

`packages/cache/package.json` segue a convenção de `@ruguin/utils` e `@ruguin/ddd-kernel`: **TypeScript cru, sem build, sem `dist/`**, com dois export paths:

```json
"exports": {
  ".": "./src/index.ts",
  "./nestjs": "./src/nestjs/index.ts"
}
```

**Dependencies:** `iovalkey`, `@ruguin/utils` (workspace), `@ruguin/ddd-kernel` (workspace), `@ruguin/env` (workspace).
**PeerDependencies (opcionais, só para `./nestjs`):** `@nestjs/common`, `@nestjs/terminus`, `@opentelemetry/api`.

O núcleo permanece agnóstico de framework — o `dispatch-worker` futuro pode consumir `@ruguin/cache` sem arrastar NestJS.

## 3. Forma da chave

```text
{CACHE_PREFIX}:{namespace}:v{versão}:{key}
 ruguin:iam   : user      : v7      : 123
 └─ env, por    └─ por chamada       └─ do chamador
    serviço        (grupo de invalidação)
```

`infra/key-builder.ts` é o único lugar que monta essa string. Ele valida a `key` e o `namespace` antes de concatenar: ambos precisam ser não vazios e não conter espaço, quebra de linha ou `:`. Chave inválida retorna `InvalidCacheKeyError` — validação na fronteira do sistema, conforme `CLAUDE.md`.

## 4. Versionamento de namespace

Invalidar um grupo de chaves não apaga nada:

```text
SET  ruguin:iam:user:v7:123        → grava
INCR ruguin:iam:user:__version__   → 7 vira 8
```

A partir do incremento, toda leitura monta `...:v8:...` e dá miss; as chaves `v7` tornam-se inalcançáveis e morrem sozinhas quando o TTL vence. Custo O(1), sem `SCAN` e sem `DEL` em massa.

### 4.1 Duas fontes de atraso

Resolver a versão a cada operação custaria um round-trip extra, então o valor é memorizado em processo por `CACHE_NS_VERSION_LOCAL_TTL_MS`. Mas essa memoização não é a única fonte de atraso:

| Fonte                                           | Janela                                               | Como zerar                 |
| ----------------------------------------------- | ---------------------------------------------------- | -------------------------- |
| Memoização local da versão                      | até `CACHE_NS_VERSION_LOCAL_TTL_MS` (default 5000ms) | não consultar o memo       |
| Lag de replicação (o `INCR` acontece no master) | normalmente <1ms, com picos                          | ler a versão do **master** |

Zerar apenas a primeira não basta: ler a versão "fresca" de uma réplica que ainda não recebeu o `INCR` continua devolvendo a versão antiga. Consistência forte exige **as duas** — ignorar o memo e ler do master.

### 4.2 Dois modos de consistência

O pacote expõe os dois, com resolução em cascata:

```text
consistency = input.consistency
           ?? namespaces[ns].consistency        (config da factory)
           ?? CACHE_DEFAULT_CONSISTENCY         (env, default 'eventual')
```

Declarar no nível do namespace é o caminho preferencial, porque correção que depende de lembrar uma flag em cada call site é frágil: se `api-key` nunca tolera janela, isso se declara uma vez, não em doze lugares.

```ts
CacheFactory.create({
  namespaces: {
    'api-key': { consistency: 'strong' },
    suppression: { consistency: 'strong' }
    // não declarado → CACHE_DEFAULT_CONSISTENCY
  }
})
```

**Modo `eventual`** — consulta o memo local; em miss, lê a versão da réplica (com fallback para o master). Janela máxima: `CACHE_NS_VERSION_LOCAL_TTL_MS` + lag de replicação.

**Modo `strong`** — ignora o memo e resolve a versão no master. Para não pagar dois round-trips, a resolução da versão e a leitura do valor acontecem **dentro do servidor**, num único `EVAL`:

```lua
-- KEYS[1] = {prefix}:{ns}:__version__
-- ARGV[1] = {prefix}:{ns}          ARGV[2] = chave lógica
local version = redis.call('GET', KEYS[1]) or '1'
return redis.call('GET', ARGV[1] .. ':v' .. version .. ':' .. ARGV[2])
```

Pipeline comum não resolveria isso: o segundo comando depende do **valor** retornado pelo primeiro para montar sua chave, e pipeline não expressa dependência de dados. Lua é o que torna o modo forte um único round-trip.

O custo real do modo `strong`, portanto, não é latência de round-trip — é **ir ao master em vez da réplica**. Trocar ~0,2ms por garantia é um negócio melhor que trocar ~0,3ms por uma janela de 5 segundos.

Uma leitura `strong` também **atualiza** o memo local (acabou de obter uma versão fresca do master), o que beneficia as leituras `eventual` seguintes.

Esse otimização de round-trip único cobre `get` e `getOrSet`, o caminho quente. As demais leituras namespaceadas (`getScore`, `getRank`, `getTopScores`, `countScores`) em modo `strong` fazem dois round-trips ao master — resolvem a versão, depois executam o comando. Escrever um script Lua por formato de comando não se paga para operações que raramente exigem o modo forte.

### 4.3 Broadcast de invalidação (Pub/Sub)

`invalidateNamespace` faz `INCR` e em seguida publica em `{CACHE_PREFIX}:__invalidation__`. Cada instância assina esse canal e, ao receber, atualiza o memo local imediatamente — derrubando a janela típica do modo `eventual` de segundos para milissegundos.

Isso **não** substitui o modo `strong`, e a distinção importa:

| Mecanismo     | Natureza                      | Papel                                                           |
| ------------- | ----------------------------- | --------------------------------------------------------------- |
| Pub/Sub       | best-effort (fire-and-forget) | encurta a janela típica                                         |
| TTL do memo   | garantido                     | é o **teto** da janela; o backstop quando uma mensagem se perde |
| Modo `strong` | garantido                     | elimina a janela por completo                                   |

Regras de implementação que preservam a correção:

- **Conexão dedicada.** Um cliente em modo subscribe não aceita comandos normais, então o `ValkeyConnectionManager` mantém uma terceira conexão além de master e réplicas.
- **Reconexão invalida tudo.** Ao reconectar, a instância pode ter perdido mensagens durante a queda — então descarta o memo inteiro, e não apenas o do namespace afetado.
- **Versão só avança.** Uma mensagem só é aplicada se trouxer versão maior que a conhecida, para que reordenação ou reentrega não faça o memo retroceder.
- **Mensagem própria é inofensiva.** Quem publicou também recebe; aplicar de novo a mesma versão é idempotente.

### 4.4 Falha na resolução da versão

Se a leitura da versão falhar (Valkey fora), o provider usa a última versão conhecida localmente, ou `1` se nunca leu — coerente com o fail-open: cache indisponível degrada, não quebra. No modo `strong`, porém, servir dado potencialmente inválido contradiz a garantia pedida: a operação retorna miss, forçando o `getOrSet` a consultar o `loader`. Modo forte prefere ir à fonte a arriscar dado velho.

## 5. Contratos

Todos seguem o padrão do monorepo: um namespace `...DTO` com `Input` / `OutputError` / `OutputSuccess` / `Output`, e uma interface com um método. Genéricos ficam **no método**, nunca na interface — assim `ICacheProvider` não vira `ICacheProvider<T>` e os tokens de injeção do NestJS dispensam parâmetro de tipo.

As subseções a seguir detalham os contratos cujo desenho envolve decisão não óbvia. Os demais (`delete`, `setIfNotExists`, contadores, `connect`/`disconnect`, `invalidateNamespace`) seguem o mesmo padrão mecanicamente e estão listados em §2.

### 5.1 `IGetCacheProvider`

```ts
export namespace GetCacheProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    consistency?: CacheConsistency // ausente → cascata do §4.2
    validate?: (value: unknown) => boolean
  }>

  export type OutputError = Readonly<
    CacheConnectionError | CacheTimeoutError | CacheSerializationError | InvalidCacheKeyError
  >
  export type OutputSuccess<T> = Readonly<{ value: T | null }>

  export type Output<T> = Promise<Either<OutputError, OutputSuccess<T>>>
}

export interface IGetCacheProvider {
  get<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T>
}
```

`validate` é opcional e resolve um bug silencioso: após um deploy que muda o shape de um tipo, o cache ainda devolve o JSON antigo e o cast para `T` mente. Quando `validate` retorna `false`, o valor é tratado como **miss** (não como erro) e recarregado.

### 5.2 `ISetCacheProvider`

```ts
export namespace SetCacheProviderDTO {
  export type Input<T> = Readonly<{
    key: string
    namespace: string
    value: T
    ttlInMs?: number // ausente → CACHE_DEFAULT_TTL_MS
    applyJitter?: boolean // ausente → true
  }>

  export type OutputError = Readonly<
    CacheConnectionError | CacheTimeoutError | CacheSerializationError | InvalidCacheKeyError
  >
  export type OutputSuccess = Readonly<{ expiresAt: Date }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface ISetCacheProvider {
  set<T>(input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output
}
```

O genérico fica só no `Input` — `Output` não depende de `T`, então declará-lo como `Output<T>` criaria um parâmetro de tipo inútil.

O jitter aplica `ttl * (1 ± CACHE_JITTER_RATIO)`. Sem ele, mil chaves gravadas no mesmo deploy expiram no mesmo milissegundo e o pico de carga volta em ondas.

### 5.3 `IGetOrSetCacheProvider` (cache-aside)

```ts
export namespace GetOrSetCacheProviderDTO {
  export type Input<T, E> = Readonly<{
    key: string
    namespace: string
    ttlInMs?: number // ausente → CACHE_DEFAULT_TTL_MS
    negativeTtlInMs?: number // ausente → CACHE_NEGATIVE_TTL_MS
    consistency?: CacheConsistency // ausente → cascata do §4.2
    forceRefresh?: boolean
    lock?: Readonly<{ enabled: boolean; waitTimeoutInMs?: number }>
    validate?: (value: unknown) => boolean
    loader: () => Promise<Either<E, T | null>>
  }>

  export type OutputError<E> = Readonly<E>
  export type OutputSuccess<T> = Readonly<{ value: T | null; source: CacheSource }>

  export type Output<T, E> = Promise<Either<OutputError<E>, OutputSuccess<T>>>
}
```

Três pontos deliberados:

- **`OutputError<E> = E`** — nenhum erro de cache aparece no tipo de falha. O fail-open fica codificado no sistema de tipos: é impossível esse método retornar um `CacheConnectionError`. Erros de cache são registrados no logger e descartados; só a falha do `loader` propaga.
- **`loader` devolve `Either<E, T | null>`** — "não encontrado" não é erro, é o caso do negative caching: grava-se uma sentinela com `negativeTtlInMs` para não martelar o banco com a mesma chave inexistente.
- **`source: 'cache' | 'loader'`** — torna hit-rate mensurável sem instrumentação extra e permite ao teste afirmar "a segunda chamada veio do cache" sem inspecionar o Valkey.

`forceRefresh: true` pula a leitura, executa o `loader` e **reescreve** o cache — é refresh, não bypass. Continua adquirindo o lock: um refresh forçado disparado por várias instâncias ao mesmo tempo produziria exatamente o stampede que o lock existe para evitar.

### 5.4 Lock

```ts
export namespace AcquireLockProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    ttlInMs: number // obrigatório, sem default
    retry?: Readonly<{ attempts: number; delayInMs: number }>
  }>

  export type OutputError = Readonly<
    CacheConnectionError | CacheTimeoutError | LockNotAcquiredError | InvalidCacheKeyError
  >
  export type OutputSuccess = Readonly<{ token: string; expiresAt: Date }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}
```

Ao contrário do cache, o TTL do lock **não** aceita default: cache sem TTL desperdiça memória, lock sem TTL é deadlock — se o processo que segurava o lock morre, ninguém mais o adquire.

`token` é um UUID gerado por aquisição. `release` e `extend` executam um script Lua de compare-and-swap, então um processo lento cujo lock já expirou não consegue liberar (nem estender) o lock que **outro** processo adquiriu depois. Sem o token, `release` seria um `DEL` cego capaz de derrubar a exclusão mútua alheia.

`IExecuteWithLockProvider` (camada `application`) adquire, executa o callback e libera no `finally`. Quem precisar do controle fino ainda pode usar acquire/release diretamente, mas o caminho ergonômico é o que não vaza lock.

**Limitação conhecida e aceita:** em failover assíncrono do master, um lock concedido pode não ter sido replicado e ser reconcedido. É um lock best-effort, adequado para evitar stampede e trabalho duplicado — não para invariantes que exijam exclusão mútua garantida.

### 5.5 Score

Sete contratos sobre sorted sets: `setScore` (`ZADD`), `incrementScore` (`ZINCRBY`), `getScore` (`ZSCORE`), `getRank` (`ZREVRANK`), `getTopScores` (`ZREVRANGE ... WITHSCORES`), `removeScore` (`ZREM`), `countScores` (`ZCARD`).

`getRank` devolve `{ rank: number | null; total: number }` — posição isolada raramente serve; "12º de 340" é o que a interface consome, e sai numa pipeline de dois comandos.

Sorted sets não têm TTL por membro, só por chave: o TTL desses contratos aplica-se ao conjunto inteiro.

### 5.6 Health check

```ts
export namespace HealthCheckProviderDTO {
  export type Input = Readonly<{ includeReplicas?: boolean; timeoutInMs?: number }>

  export type OutputError = Readonly<CacheNotInitializedError>
  export type OutputSuccess = Readonly<{
    status: CacheHealthStatus
    driver: CacheDriver
    checkedAt: Date
    master: Readonly<{ reachable: boolean; latencyInMs: number; role: string; error?: string }>
    replicas: ReadonlyArray<
      Readonly<{
        host: string
        reachable: boolean
        latencyInMs: number
        replicationLagInBytes: number | null
        error?: string
      }>
    >
    memory: Readonly<{ usedBytes: number; maxBytes: number | null; usedPercentage: number | null; evictedKeys: number }>
    clients: Readonly<{ connected: number; blocked: number; rejectedTotal: number }>
    server: Readonly<{ version: string; uptimeInSeconds: number }>
  }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}
```

Dados coletados via `PING` (latência) e `INFO replication|memory|clients|server`.

| Status      | Condição                                                                            | Significado operacional                       |
| ----------- | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| `healthy`   | master responde, réplicas OK, lag < limite, memória < 90%                           | normal                                        |
| `degraded`  | master OK, mas réplica inalcançável **ou** lag acima do limite **ou** memória ≥ 90% | leituras caem no master; a aplicação funciona |
| `unhealthy` | master não responde                                                                 | fail-open mantém a aplicação viva, sem cache  |

Os três sinais além do `PING` existem para pegar problema antes do incidente: **lag de replicação** denuncia réplica servindo dado velho (crítico, já que leituras são roteadas para ela); **`evictedKeys` crescendo** significa que o Valkey descarta chaves por pressão de memória e o hit-rate vai despencar sem que erro algum apareça; **`rejectedTotal`** aponta esgotamento de `maxclients`, que se manifesta como timeout intermitente e depois some.

"Não saudável" **não** é falha do `Either` — é a resposta correta que o chamador precisa ler. `OutputError` fica reservado a `CacheNotInitializedError` (chamar antes do `connect()`, que é erro de programação).

## 6. Fluxo do `getOrSet`

```text
1. resolve o modo de consistência (cascata do §4.2)
2. forceRefresh? ──sim──────────────────────────────────────────────┐
   │não                                                             │
3. leitura, conforme o modo:                                        │
   ├─ eventual → resolve versão (memo local) → GET na réplica       │
   └─ strong   → EVAL no master (versão + GET num round-trip)       │
      ├─ hit valor      → return { value, 'cache' }                 │
      ├─ hit sentinela  → return { null,  'cache' }                 │
      ├─ validate falhou → trata como miss ────────────────────────►│
      └─ miss ou erro ─────────────────────────────────────────────►│
4. adquire lock no master (se lock.enabled)                         │
   ├─ conseguiu → re-leitura (outro pode ter preenchido na espera)  │
   └─ não conseguiu até waitTimeout → segue assim mesmo             │
5. loader()  ◄──────────────────────────────────────────────────────┘
   ├─ failure → return failure(E)      ← único erro que sai daqui
   ├─ null    → SET sentinela   (negativeTtlInMs ± jitter)
   └─ valor   → SET serializado (ttlInMs ± jitter)
6. release do lock no finally (compare-and-delete por token)
7. return { value, 'loader' }
```

A re-leitura do passo 4 é o que faz o lock valer a pena: sem ela, todos os que esperaram na fila executariam o `loader` em sequência, trocando um stampede paralelo por um serial.

A escrita do passo 5 usa a versão vigente no momento da escrita. Se um `invalidateNamespace` ocorrer entre a leitura e a escrita, o valor é gravado sob a versão antiga e nasce inalcançável — desperdiça uma escrita, mas não serve dado obsoleto, e a chave morre no TTL.

A sentinela do negative cache é um marcador interno reservado, distinguível de um valor legítimo `null` gravado pelo usuário.

## 7. Decorators

Ambos implementam `ICacheProvider` e envolvem outro `ICacheProvider` — adicionar qualquer um deles não modifica nenhum driver (OCP). A factory os aplica na ordem `observable(resilient(driver))`, para que o span registre inclusive as chamadas curto-circuitadas pelo breaker.

**`ObservableCacheProvider`** — abre um span por operação via `@opentelemetry/api` (que o `core-server` já configura em `create-tracing-sdk.ts`), com atributos de namespace, operação e resultado (hit/miss/erro).

**`ResilientCacheProvider`** — circuit breaker. Com fail-open e sem breaker, um Valkey fora do ar faz **toda** requisição pagar o timeout de conexão antes de cair no banco: o cache indisponível deixa a API lenta em vez de apenas "sem cache". O breaker abre após N falhas consecutivas, passa a pular o cache instantaneamente, e a cada intervalo deixa uma requisição sondar; respondendo, fecha.

| Estado      | Comportamento                                                      |
| ----------- | ------------------------------------------------------------------ |
| `closed`    | opera normalmente; conta falhas consecutivas                       |
| `open`      | pula o cache sem I/O; leituras retornam miss, escritas viram no-op |
| `half-open` | deixa uma requisição passar; sucesso fecha, falha reabre           |

Escritas viradas no-op com o breaker aberto são seguras: o dado permanece correto na fonte, e a única perda é o benefício do cache.

## 8. Drivers

| Driver   | Uso                    | Notas                                                                                                            |
| -------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `valkey` | produção e integração  | `iovalkey`; master obrigatório, réplicas opcionais                                                               |
| `memory` | dev e teste sem Docker | `Map` com expiração por timestamp; **por processo** — locks e contadores não são compartilhados entre instâncias |
| `noop`   | desligar cache         | Null Object: leituras sempre miss, escritas descartadas, health sempre `healthy`                                 |

O `memory` não é um substituto de produção e sua limitação é intencionalmente documentada: seu "lock distribuído" só exclui dentro do mesmo processo.

Os três implementam exatamente os mesmos contratos — é isso que prova que a abstração não vazou detalhe do Valkey.

### 8.1 Roteamento master/réplica (driver `valkey`)

`ValkeyConnectionManager` mantém três tipos de conexão: master, uma por réplica, e uma dedicada ao subscriber de invalidação (§4.3) — um cliente em modo subscribe não aceita comandos normais.

| Operação                                                                                                 | Destino                                           |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| leituras em modo `eventual` (`get`, `getScore`, `getRank`, `getTopScores`, `countScores`)                | réplica (round-robin), com fallback para o master |
| leituras em modo `strong` (as mesmas, §4.2)                                                              | master, sempre                                    |
| `set`, `delete`, `setIfNotExists`, **todos os contadores**, scores (escrita), locks, versão de namespace | master, sempre                                    |
| `healthCheck`                                                                                            | master e cada réplica                             |

Locks vão ao master por definição: adquirir um lock lendo de uma réplica com lag reconstruiria o problema que o lock resolve.

Contadores vão ao master **inclusive na leitura** (`getCounter`), diferentemente do `get` comum. O motivo é o caso de uso: contador aqui serve a rate limiting, e uma réplica com lag devolveria contagem menor que a real, deixando passar requisições acima do limite. Um valor de cache velho custa um miss; um contador de rate limit velho custa a garantia.

Sem réplicas configuradas, tudo vai ao master.

## 9. Alterações em `@ruguin/env`

Em `packages/env/src/packages/cache.environment.ts`:

| Variável                                | Mudança                      | Validação                                                              |
| --------------------------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| `CACHE_DRIVER`                          | adicionar `'valkey'` ao enum | `z.enum(['valkey', 'memory', 'noop']).default('memory')`               |
| `CACHE_MASTER_URL`                      | **nova**                     | `z.string().url().optional()` — obrigatória quando o driver é `valkey` |
| `CACHE_REPLICA_URLS`                    | **nova**                     | string separada por vírgula, transformada em array; default vazio      |
| `CACHE_OPERATION_TIMEOUT_MS`            | **nova**                     | `z.coerce.number().int().positive().default(500)`                      |
| `CACHE_BREAKER_FAILURE_THRESHOLD`       | **nova**                     | `z.coerce.number().int().positive().default(5)`                        |
| `CACHE_BREAKER_RESET_TIMEOUT_MS`        | **nova**                     | `z.coerce.number().int().positive().default(10_000)`                   |
| `CACHE_REPLICATION_LAG_THRESHOLD_BYTES` | **nova**                     | `z.coerce.number().int().nonnegative().default(1_048_576)`             |
| `CACHE_DEFAULT_CONSISTENCY`             | **nova**                     | `z.enum(['eventual', 'strong']).default('eventual')`                   |
| `CACHE_INVALIDATION_BROADCAST`          | **nova**                     | `z.stringbool().default(true)` — liga o Pub/Sub do §4.3                |

`CACHE_PREFIX`, `CACHE_DEFAULT_TTL_MS`, `CACHE_JITTER_RATIO`, `CACHE_NEGATIVE_TTL_MS` e `CACHE_NS_VERSION_LOCAL_TTL_MS` permanecem como estão e passam a ser efetivamente consumidos.

O default `eventual` é deliberado: o modo forte custa um hop ao master em toda leitura, e transformá-lo em padrão global concentraria no master a carga que as réplicas existem para absorver. Quem precisa de garantia declara o namespace (§4.2) — o custo fica onde a necessidade está.

A obrigatoriedade condicional de `CACHE_MASTER_URL` usa um refinement no schema (driver `valkey` sem URL falha no startup), preservando o princípio do pacote: variável ausente quebra no boot, não no meio de uma request.

`packages/env/src/packages/__tests__/cache.environment.unit.ts` precisa ser atualizado — o caso "rejects an unknown driver instead of silently falling back" usa hoje `valkey` como exemplo de valor inválido (linha 61). Trocar por um valor genuinamente inválido (`'redis'`) e adicionar caso afirmando que `valkey` é aceito.

## 10. Integração NestJS

`@ruguin/cache/nestjs` — módulo dinâmico:

```ts
// apps/core-server/src/app.module.ts
CacheModule.forRoot({ isGlobal: true })
```

- `forRoot(options)` / `forRootAsync(options)`, com `isGlobal` opcional.
- Registra um provider por contrato sob tokens `Symbol` (`GET_CACHE_PROVIDER`, `CACHE_PROVIDER`, …), todos resolvendo para a mesma instância produzida pela `CacheFactory`. Consumidores escolhem o nível de acoplamento no ponto de injeção.
- `onModuleInit` chama `connect()`; `onApplicationShutdown` chama `disconnect()`.
- `@InjectCache()` é açúcar para `@Inject(CACHE_PROVIDER)`.

### 10.1 Health indicator

`CacheHealthIndicator` estende `HealthIndicator` do `@nestjs/terminus` e converte o resultado de `healthCheck()` no formato do Terminus. `HealthController` passa de `this.health.check([])` para:

```ts
this.health.check([() => this.cacheHealth.isHealthy('cache')])
```

`degraded` conta como **up** na readiness: remover a instância do balanceador porque uma réplica caiu transformaria uma degradação em indisponibilidade. Apenas `unhealthy` marca o indicador como down, e os detalhes coletados vão no payload em ambos os casos, para o alerta distinguir os cenários.

`HealthModule` passa a importar o `CacheModule` (ou depende do registro global).

## 11. Erros

Todos estendem `BaseError` de `@ruguin/ddd-kernel`, com `name` e `status`:

| Erro                       | `StatusError`    | Origem                                          |
| -------------------------- | ---------------- | ----------------------------------------------- |
| `CacheConnectionError`     | `INTERNAL_ERROR` | conexão recusada ou perdida                     |
| `CacheTimeoutError`        | `INTERNAL_ERROR` | operação excedeu `CACHE_OPERATION_TIMEOUT_MS`   |
| `CacheSerializationError`  | `INTERNAL_ERROR` | JSON inválido ou estrutura cíclica              |
| `CacheNotInitializedError` | `INTERNAL_ERROR` | uso antes de `connect()`                        |
| `InvalidCacheKeyError`     | `INVALID_INPUT`  | chave/namespace vazio ou com caractere proibido |
| `LockNotAcquiredError`     | `CONFLICT`       | lock ocupado após os retries                    |
| `LockNotOwnedError`        | `CONFLICT`       | release/extend com token que já não é o dono    |

Nenhum caminho do pacote lança exceção para falha esperada — tudo retorna `Either`, conforme a convenção do monorepo.

## 12. Testes

**Unit** (`vitest`, sem infra) — orquestradores da `application` com contratos mockados: prevenção de stampede, fail-open, negative cache, `forceRefresh`, re-leitura pós-lock, release no `finally`. Mais: drivers `memory` e `noop`, `JsonSerializerStrategy`, `key-builder` (incluindo chaves inválidas), derivação do status de health a partir de payloads de `INFO`, máquina de estados do breaker, e o `namespace-version.resolver` — cascata de consistência (chamada > namespace > env), expiração do memo, e a regra de que uma mensagem de invalidação só é aplicada se a versão for maior.

**Integração** (contra o serviço `redis` do `docker-compose`) — driver Valkey real: expiração efetiva de TTL, semântica de `SET NX PX`, o Lua liberando apenas para o dono do token, roteamento master/réplica com fallback, parse do `INFO` de uma instância viva, e ciclo completo de `getOrSet` (miss → grava → hit).

Três cenários de integração merecem menção explícita, porque são exatamente os que motivaram o §4:

- **Modo `strong` enxerga invalidação imediatamente** — duas instâncias do provider apontando ao mesmo Valkey; a instância A invalida o namespace, e a instância B, lendo em modo `strong`, dá miss na leitura seguinte, sem esperar nada.
- **Modo `eventual` respeita o teto** — com o broadcast desligado (`CACHE_INVALIDATION_BROADCAST=false`), a instância B pode servir dado antigo, mas nunca além de `CACHE_NS_VERSION_LOCAL_TTL_MS`.
- **Broadcast encurta a janela** — com o broadcast ligado, a instância B enxerga a invalidação em milissegundos, muito antes do TTL do memo. E, após uma reconexão forçada do subscriber, o memo é descartado por inteiro.

O pacote adota `vitest.config.ts` com projetos `unit` e `integration`, espelhando o que `apps/core-server` já faz, para que `test:unit` rode sem Docker no pre-commit e a integração fique explícita no CI.

## 13. Ordem de implementação

1. `@ruguin/env` — variáveis novas e correção do teste do driver.
2. Esqueleto do pacote — `package.json`, `tsconfig`, `vitest.config.ts`, `eslint`.
3. `domain/` — enums, erros, contratos (nenhuma implementação).
4. `infra/serializers` + `infra/key-builder` — as peças puras.
5. Drivers `noop` e `memory` — validam os contratos sem I/O.
6. `application/` — `getOrSet` e `executeWithLock`, testados sobre o driver `memory`.
7. `infra/namespace-version.resolver.ts` — cascata de consistência e memo, testável sem I/O.
8. Driver `valkey` — conexão, operations, scripts Lua, broadcast de invalidação, testes de integração.
9. Decorators — observabilidade e breaker.
10. `factory/` — composição, incluindo a config `namespaces`.
11. `nestjs/` — módulo, tokens, health indicator.
12. Integração no `core-server` — `app.module.ts` e `health.controller.ts`.

Implementar `noop`/`memory` antes do `valkey` é deliberado: se os contratos servem bem a três implementações muito diferentes, é sinal de que não vazaram detalhe de nenhuma delas — e a camada `application` fica testável antes de existir qualquer I/O.

## 14. Riscos

| Risco                                                               | Mitigação                                                                                            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Memoização da versão de namespace serve dado velho após invalidação | Namespace declarado `strong` elimina a janela (§4.2); broadcast a encurta; TTL do memo é o teto      |
| Namespace crítico esquecido no modo `eventual`                      | Declaração fica na config da factory, revisável num lugar só — não espalhada por call site           |
| Mensagem de invalidação perdida (Pub/Sub é fire-and-forget)         | TTL do memo continua sendo o backstop; reconexão do subscriber descarta o memo inteiro               |
| Modo `strong` concentra leitura no master                           | Default global é `eventual`; só namespaces declarados pagam o hop                                    |
| Lock perdido em failover do master                                  | Documentado como best-effort; não usar para invariante crítica                                       |
| Réplica com lag serve dado velho                                    | Health reporta `degraded` acima do limite; modo `strong` lê do master; `forceRefresh` ignora o cache |
| Facade de ~25 métodos convida a acoplamento excessivo               | Contratos granulares permanecem a via preferencial; o Facade é conveniência                          |
| Conexão extra por instância para o subscriber                       | Uma só, independente do número de namespaces; desligável por `CACHE_INVALIDATION_BROADCAST=false`    |
| Chave sem TTL por default esquecido                                 | `CACHE_DEFAULT_TTL_MS` garante expiração; lock exige TTL explícito                                   |
