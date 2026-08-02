# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

## Purpose

`@ruguin/utils` — the smallest, most-depended-on package. It provides the **`Either` monad** that underpins error handling across the entire monorepo. Keep it dependency-free and tiny.

## Structure

```text
src/
  either/either.utility.ts   # Failure<F,S>, Success<F,S>, Either<F,S>, failure(), success()
  index.ts                   # barrel export
```

## The `Either` contract

```ts
import { type Either, failure, success } from '@ruguin/utils'

function parse(input: string): Either<MyError, number> {
  if (!ok) return failure(new MyError())
  return success(42)
}

const r = parse(x)
if (r.isFailure()) return r.value   // r.value is MyError, narrowed
const n = r.value                   // r.value is number, narrowed
```

- `isFailure()` / `isSuccess()` are **type guards** (`this is Failure<…>`), so they narrow `.value` — always branch on them before reading `.value`.
- By convention `F` (the left/failure type) is the error; `S` (right/success) is the value.

## Rules

- **No runtime dependencies.** This package must stay a leaf in the dependency graph — everything imports it, it imports nothing.
- **Built with `tsdown`, exports `./dist/index.mjs`.** Node refuses to type-strip `.ts` files that
  live under `node_modules`; a package consumed as raw source only works while pnpm's symlink keeps
  it outside `node_modules`, in the workspace itself. Any packaging step that materializes the
  files — `pnpm deploy`, and therefore any container image — puts them inside `node_modules`, where
  that symlink no longer helps. Build before consuming as a dependency; `tsdown.config.ts` mirrors
  `packages/cache`'s.
- Any addition here is used everywhere — prefer minimal, universal helpers only.

## Commands

```bash
pnpm --filter @ruguin/utils test:unit
pnpm --filter @ruguin/utils check:types
```
