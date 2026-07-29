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
- **Raw TS, no build.** It's a private package that exports `./src/index.ts` directly (see `package.json` `exports`). Consumers compile it themselves; there is **no `dist/` and no `build` script**. Do not add one.
- Any addition here is used everywhere — prefer minimal, universal helpers only.

## Commands

```bash
pnpm --filter @ruguin/utils test:unit
pnpm --filter @ruguin/utils check:types
```
