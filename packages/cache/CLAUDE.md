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
  index.ts        # barrel: application, domain, infra
```

## Rules

- TypeScript cru, sem build — exporta `./src/index.ts` direto, sem `dist/`.
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

## Commands

```bash
pnpm --filter @ruguin/cache test:unit
pnpm --filter @ruguin/cache check:types
pnpm --filter @ruguin/cache check:lint
pnpm --filter @ruguin/cache test:integration   # exige docker compose up -d redis redis-replica
```
