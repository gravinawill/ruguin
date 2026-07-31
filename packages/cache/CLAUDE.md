# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

## Purpose

`@ruguin/cache` — Clean Architecture cache provider for the monorepo's services. Domain contracts describe every leaf operation (get/set/delete, counters, locks, sorted scores, namespace invalidation, connection lifecycle, health) plus the two orchestrators composed on top of them. Drivers adapt one storage technology to the leaf contracts; `memory` and `noop` ship today, `valkey` is a future plan. Depends on `@ruguin/utils` (for `Either`) and `@ruguin/ddd-kernel`.

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
  index.ts        # barrel: application, domain, infra
```

## Rules

- TypeScript cru, sem build — exporta `./src/index.ts` direto, sem `dist/`.
- Driver implementa `ICacheDriver` (contratos folha); `getOrSet` e `executeWithLock` vivem em `application/` e servem a qualquer driver.
- Todo caminho retorna `Either`; nada lança para falha esperada.
- `getOrSet` é fail-open por contrato — o tipo `OutputError<E> = E` impede propagar erro de cache.
- O driver `memory` é para dev e teste: seu lock só exclui dentro do mesmo processo.

## Commands

```bash
pnpm --filter @ruguin/cache test:unit
pnpm --filter @ruguin/cache check:types
pnpm --filter @ruguin/cache check:lint
```
