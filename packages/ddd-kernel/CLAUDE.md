# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

## Purpose

`@ruguin/ddd-kernel` — DDD building blocks shared across the monorepo's services (today only `core-server`, but meant for the future `dispatch-worker`, `tracking-service`, etc.): `BaseError`, `StatusError`, and generic value objects like `ID`. Depends on `@ruguin/utils` (for `Either`); no other package in the monorepo depends on this one in the other direction.

## Structure

```text
src/
  enums/status-error.enum.ts   # semantic error categories, mapped to HTTP by the consumer
  errors/base-error.ts         # abstract class every domain error extends
  value-objects/id/
    id.value-object.ts         # ID (UUID v7); validate()/generate() return Either
    errors/                    # InvalidIDError, GenerateIDError
  index.ts                     # barrel export
```

## Rules

- **No bounded-context-specific business logic.** Only generic primitives reusable by any service.
- **Built with `tsdown`, exports `./dist/index.mjs`.** Node refuses to type-strip `.ts` files that
  live under `node_modules`; a package consumed as raw source only works while pnpm's symlink keeps
  it outside `node_modules`, in the workspace itself. Any packaging step that materializes the
  files — `pnpm deploy`, and therefore any container image — puts them inside `node_modules`, where
  that symlink no longer helps. Build before consuming as a dependency; `tsdown.config.ts` mirrors
  `packages/cache`'s.
- Every concrete error extends `BaseError` and implements `name`/`status`; every expected failure uses `Either`, never `throw`.

## Commands

```bash
pnpm --filter @ruguin/ddd-kernel test:unit
pnpm --filter @ruguin/ddd-kernel check:types
```
