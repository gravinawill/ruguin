# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

## Purpose

`@ruguin/env` — typed, validated environment access. The **only** place `process.env` is read. Every other package/app imports a typed, parsed env object from here so a missing or malformed variable fails fast at startup, not deep in a request.

## Structure

```
src/
  shared/server.environment.ts        # serverENV — ENVIRONMENT; exports EnvironmentEnum + Environment type
  packages/token-provider.environment.ts  # tokenProviderENV — all JWT_* vars
  index.ts                            # re-exports ./shared and ./packages
```

## Pattern

Each env object is built with `@t3-oss/env-core`'s `createEnv` + a `zod` schema, with `emptyStringAsUndefined: true` and `runtimeEnv: process.env`:

```ts
export const serverENV = createEnv({
  server: { ENVIRONMENT: z.enum(Object.values(EnvironmentEnum)) },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true
})
```

`EnvironmentEnum`: `TEST | LOCAL | DEVELOP | STAGING | PRODUCTION`.

## Adding a variable

1. Add the field with a `zod` validator (and a sensible `.default(...)` where safe) to the relevant `*.environment.ts`.
2. Group by concern — one `createEnv` object per bounded area (`serverENV`, `tokenProviderENV`, …); don't dump everything into one.
3. Consumers import the object (e.g. `tokenProviderENV.JWT_ISSUER`) — they must **never** read `process.env` themselves.

## Rules

- **Raw TS, no build.** Private package; exports `./src/index.ts` directly. No `dist/`, no `build` script.
- Env loading at runtime uses `@dotenvx/dotenvx` from the root (`pnpm with-env …`); this package only defines and validates the schema.

## Commands

```bash
pnpm --filter @ruguin/env test:unit
pnpm --filter @ruguin/env check:types
```

## Dependencies

`@t3-oss/env-core`, `zod`.
