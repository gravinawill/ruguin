# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

## Purpose

`@ruguin/cache` — Clean Architecture cache provider for the monorepo's services. Domain contracts describe every leaf operation (get/set/delete, counters, locks, sorted scores, namespace invalidation, connection lifecycle, health) plus the two orchestrators composed on top of them. Drivers adapt one storage technology to the leaf contracts; all three drivers ship today. Depends on `@ruguin/utils` (for `Either`) and `@ruguin/ddd-kernel`.

## Structure

```text
src/
  domain/
    contracts/          # ICacheDriver, ICacheProvider and one interface per leaf operation
    enums/               # CacheSource, CacheConsistency, CacheDriver, CacheHealthStatus
    errors/              # CacheConnectionError, LockNotAcquiredError, etc. — all extend BaseError
  application/
    get-or-set-cache.provider.ts    # cache-aside with stampede-protecting lock + re-read
    execute-with-lock.provider.ts   # mutual exclusion, no fail-open
    cache-provider.facade.ts        # ICacheProvider — delegates to a driver + the two orchestrators
  infra/
    key-builder.ts                  # namespace + key -> physical key, with validation
    namespace-version.resolver.ts   # namespace invalidation via version cascade
    serializers/json-serializer.strategy.ts
    drivers/
      memory/     # in-memory store, lazy ttl expiry — dev and test only
      noop/       # always-miss driver — cache disabled without branching call sites
      valkey/     # iovalkey: master + replicas + a dedicated subscriber connection
    decorators/   # observable(resilient(driver)) — spans and circuit breaker over ICacheDriver
  factory/
    cache.factory.ts   # the single composition root: picks the driver, applies the decorators
  nestjs/         # optional adapter behind the ./nestjs export: CacheModule, tokens, health indicator
  index.ts        # barrel: application, domain, infra — the framework-agnostic surface
```

## Rules

- **O pacote inteiro é buildado (`tsdown`) e exporta `./dist/index.mjs`.** Não é TypeScript cru: o
  barrel reexporta `nestjs/`, e `@Module()`/`@Injectable()` são sintaxe que o V8 não implementa —
  type stripping não reescreve decorator, então um `cache.module.ts` cru morre no load com
  `SyntaxError: Invalid or unexpected token`.
- **Uma entry só (`src/index.ts`).** Uma segunda entry importando o barrel receberia cópias próprias
  de `CacheProviderFacade` e companhia, e a classe importada do barrel deixaria de ser a que o
  módulo instancia — duplicação que aparece como um `instanceof` respondendo `false` em silêncio.
  Pelo mesmo motivo, arquivos em `src/nestjs/` importam por caminho relativo, nunca por
  `@ruguin/cache`.
- Driver implementa `ICacheDriver` (contratos folha); `getOrSet` e `executeWithLock` vivem em `application/` e servem a qualquer driver.
- Todo caminho retorna `Either`; nada lança para falha esperada.
- `getOrSet` é fail-open por contrato — o tipo `OutputError<E> = E` impede propagar erro de cache.
  A observabilidade entra pelo sucesso: `lockOutcome: CacheLockOutcome` diz se o loader rodou
  sem a proteção pedida (`NOT_ACQUIRED`), estado que antes era indistinguível de uma execução
  limpa. `NOT_ATTEMPTED` cobre tanto "não pediu lock" quanto "veio do cache antes do lock".
- O driver `memory` é para dev e teste: seu lock só exclui dentro do mesmo processo.
- `acquire` recebe orçamento de espera (`wait: { timeoutInMs, pollIntervalInMs }`), não contagem
  de tentativas. Quem espera é o driver, porque só ele sabe o custo de uma tentativa: contra rede
  cada uma é um round-trip, e converter orçamento em `ceil(timeout / poll)` estoura o prazo
  justamente quando o cache está degradado. O driver ancora o prazo na entrada, não inicia
  tentativa com orçamento esgotado e não dorme além dele. `pollIntervalInMs` tem que ser
  positivo: o orçamento limita tempo decorrido, não número de tentativas, então intervalo zero
  transformaria uma espera de 3s em milhares de round-trips na mesma chave.
- O driver `noop` recusa todo lock (`acquire` → `LockNotAcquiredError`): conceder seria fabricar
  exclusão mútua que ele não tem. Com `CACHE_DRIVER=noop`, `executeWithLock` falha em vez de
  rodar a task — o único ponto do pacote onde desligar o cache muda o resultado do chamador.
- O driver `valkey` mantem tres conexoes: master, uma por replica, e uma dedicada ao subscriber
  de invalidacao — um cliente em modo subscribe recusa comandos normais. Leitura eventual vai a
  replica (round-robin, com fallback para o master); leitura forte, escrita, contador (inclusive
  na leitura) e lock vao sempre ao master.
- Os decorators envolvem `ICacheDriver`, nao `ICacheProvider`. E isso que faz o `getOrSet`
  enxergar o breaker: circuito aberto vira miss instantaneo e o cache-aside vai ao loader sem
  pagar timeout.
- O adapter NestJS sai pelo mesmo barrel, com `@nestjs/common` e `@nestjs/terminus` como peers
  **opcionais**. O barrel deixou de ser framework-agnostic quando os exports colapsaram em `.`:
  um worker sem NestJS agora carrega o `CacheModule` junto. Nada do Terminus é injetado dentro do
  pacote — o pnpm dá a ele uma cópia própria, e uma classe injetada de lá não seria a mesma que o
  `TerminusModule` provê no app.
- Os 24 tokens granulares e o `CACHE_PROVIDER` resolvem todos para a **mesma** instância
  (`useExisting`). O token escolhido no ponto de injeção decide quanto da superfície o construtor
  enxerga, não quantos objetos existem.
- `connect()` que falha no boot é reportado e o boot continua: fail-open significa que uma queda do
  Valkey degrada o serviço, não o derruba. Config inválida, ao contrário, lança — é erro de boot.
- O pacote compila com `exactOptionalPropertyTypes`, porque o `core-server` compila estes fontes com
  essa opção ligada. Campo opcional recebe spread condicional, nunca `undefined` explícito.

## Commands

```bash
pnpm --filter @ruguin/cache test:unit
pnpm --filter @ruguin/cache check:types
pnpm --filter @ruguin/cache check:lint
pnpm --filter @ruguin/cache test:integration   # exige docker compose up -d redis redis-replica
pnpm --filter @ruguin/core-server test:e2e   # inclui /health contra o Valkey real
```
