# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this app.

## Purpose

`@ruguin/core-server` — the product's API service. It owns authentication, account management
(organizations, projects, API keys, templates, domains) and accepts send requests. It is the
exclusive owner of its Postgres schema: no other service reads or writes those tables, and every
fact it publishes to the rest of the system leaves as a Kafka event.

Today `src/` holds only infrastructure. The layout below is the shape the first business module has
to take, because it becomes the precedent the other seven copy.

## Structure

```text
apps/core-server/
  src/
    <module>/                     # organization, project, api-key, template, domain, email,
                                  # webhook-endpoint, suppression
      domain/
        models/                   # aggregate roots and entities — never Prisma types
        value-objects/            # VOs owned by this module
        errors/                   # this module's domain errors (extend BaseError)
      application/
        use-cases/                # one file per use case — the only place business logic lives
        repositories/             # ports: interface + injection token
        providers/                # ports for anything else: cache, id generation, other modules
      infra/
        database/prisma/          # repository adapters
        cache/                    # cache adapters, built on @ruguin/cache
      presentation/
        <module>.controller.ts
        <module>.service.ts
        dto/
      <module>.module.ts          # binds every port to its adapter
      **/__tests__/               # next to the code under test, never one folder per module
    shared/
      database/                   # PrismaService, TransactionManager, RollbackSignal
      outbox/                     # OutboxRepository (port + Prisma), OutboxRelayService
      events/                     # adapter over packages/message-broker
    bootstrap/                    # configureApp: docs, security headers, versioning
    cache/                        # maps the validated env onto CacheModule options
    health/ logger/ tracing/      # cross-cutting infrastructure
    app.module.ts main.ts
  prisma/
    schema/
      schema.prisma               # datasource + generator only
      <module>.prisma             # one per module, plus outbox.prisma
```

**Module, not bounded context.** The bounded context is this whole service; `src/<module>/` is a
sub-domain inside it. `docs/ddd-naming-guide.md` §1 draws that line, and the older architecture spec
uses "bounded context" for both levels — follow the guide.

## Rules

- **`Controller → Service → Use Case → { Repository | Provider | Model | Value Object }`.** No layer
  skips the next. A controller that reaches a repository, or a use case that touches Prisma, breaks
  the seam that makes the layer below testable in isolation.
- **`Service` only forwards.** It holds no logic, no branching, no repository access — it calls one
  use case and returns. This is deliberate: the uniform controller signature is the point, and the
  layer is where a future cross-cutting concern lands without touching every use case. Do not delete
  it because it "does nothing"; that is its job.
- **A use case never calls another use case.** When an operation needs two, write an orchestration
  use case that talks to both repositories inside one transaction. Reusable logic belongs to a
  `Model`/VO method or a provider, never to a chain of use cases — a chain hides who owns the
  transaction boundary.
- **`Model` is never the Prisma type.** It is a domain class whose invariants are checked in a static
  `Model.create(...)` returning `Either`, like the `ID` value object. Translating between a Prisma row
  and a `Model` is the repository's private mapper and nobody else's business.
- **Port in `application/`, adapter in `infra/`, bound by token in the module.** The indirection is
  what lets a `.unit.ts` mock a repository without a database. A port whose only implementation is a
  Prisma class is still a port.
- **Repositories translate infrastructure errors into domain errors.** A unique-constraint violation
  becomes `EmailIdempotencyConflictError` with `StatusError.CONFLICT`. Nothing from the `Prisma.*`
  namespace may cross into `application/`.
- **Every expected failure returns `Either`; `throw` is for bugs only.** The one sanctioned exception
  is `RollbackSignal` inside `TransactionManager`, which exists precisely because Prisma rolls back on
  a thrown error while the rest of the codebase reports failure by value. It never escapes that class.
- **Reading another module's data goes through your own port.** Declare
  `<Aggregate>LookupProvider` in your `application/providers/` and implement it in your `infra/`.
  Importing another module's repository couples you to its persistence, and the two stop being
  separable the day one of them moves.
- **Cache goes through a module-owned port too.** Declare something like `TemplateCacheProvider`
  (`getTemplate`, `invalidateTemplate`) and implement it over `@ruguin/cache`. The use case then
  speaks its own domain instead of namespaces and TTLs, and its test mocks two methods rather than
  twenty-five.
- **Events leave through the outbox, in the same transaction as the write.** Publishing to Kafka from
  a use case creates an implicit distributed transaction: the row commits and the event is lost, or
  the reverse. The relay publishes after commit.
- **Tests live in `__tests__/` beside the code they cover** — `*.unit.ts` (no I/O), `*.int.ts` (real
  Postgres/Valkey), `*.e2e.ts` (HTTP through the built app). Every other package here does this; the
  architecture spec's single per-module folder was written before any of it existed.
- **One `.prisma` per module under `prisma/schema/`.** A single schema file crosses the repo's
  500-line rule around the fourth module, and a diff on it cannot say which module changed.
- **No CQRS, no Event Sourcing, no module-prefixed entity names.** Read/write patterns do not diverge
  yet, there is no audit requirement, and the prefix exists to stop collisions between independently
  published libraries — here one schema and one service already disambiguate, and the module is in the
  file path.

## Commands

```bash
pnpm --filter @ruguin/core-server test          # unit only, no infrastructure needed
pnpm --filter @ruguin/core-server test:integration
pnpm --filter @ruguin/core-server test:e2e      # needs docker compose up -d
pnpm --filter @ruguin/core-server check:types
pnpm --filter @ruguin/core-server check:lint
pnpm --filter @ruguin/core-server build         # nest build + fix-esm-imports
pnpm with-env pnpm --filter @ruguin/core-server start
```

`tsconfig.build.json` sets `noEmit: true` on purpose — SWC emits, tsc only type-checks. Removing it
makes TypeScript demand an explicit `rootDir`, and setting one moves the output to `dist/src/`.

## Related

- `docs/superpowers/specs/2026-07-29-core-server-architecture-design.md` — the architecture decision,
  including the transaction manager and outbox in full
- `docs/ddd-naming-guide.md` — module names, aggregate roots and their key invariants
- `packages/cache/CLAUDE.md` — the cache contracts these modules build their ports on
