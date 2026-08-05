# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

## Purpose

`@ruguin/env` — typed, validated environment access. The **only** place `process.env` is read. Every other package/app imports a typed, parsed env object from here so a missing or malformed variable fails fast at startup, not deep in a request.

## Structure

```
src/
  shared/server.environment.ts        # serverENV — ENVIRONMENT, PORT; exports EnvironmentEnum + Environment type
  packages/token-provider.environment.ts  # tokenProviderENV — all JWT_* vars
  packages/...                        # one createEnv per bounded concern (aws, cache, database, docs,
                                       # logger, message-broker, token-provider)
  apps/core-server.environment.ts     # coreServerENV — extends every package core-server actually uses
  apps/dispatch-worker.environment.ts # dispatchWorkerENV — same, for dispatch-worker
  index.ts                            # re-exports ./apps, ./packages, and ./shared
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

Each app under `apps/` composes the packages it actually depends on via `extends`, instead of every
call site importing `serverENV`/`cacheENV`/`awsENV`/… separately:

```ts
export const coreServerENV = lazyEnvironment(() =>
  createEnv({
    server: {},
    extends: [serverENV, databaseENV, cacheENV, messageBrokerENV, docsENV],
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  })
)
```

`extends` entries must be objects `@t3-oss/env-core` can enumerate (`Object.assign` reads their
own keys directly) — the `lazyEnvironment` wrapper already satisfies that, so pass the package env
object itself, not a call to it. Keep `server: {}` empty unless the app needs a variable that no
existing package already owns; a genuinely app-specific variable still gets its own `zod` field
here rather than living only in one app's schema by accident.

## Adding a variable

1. Add the field with a `zod` validator (and a sensible `.default(...)` where safe) to the relevant `*.environment.ts` package file.
2. Group by concern — one `createEnv` object per bounded area (`serverENV`, `tokenProviderENV`, …); don't dump everything into one.
3. Add that package to the `extends` array of every `apps/*.environment.ts` file whose app actually reads the new variable. Adding it to an app that doesn't use it yet makes that app's boot depend on a variable it has no reason to require.
4. Consumers import the composed app object (e.g. `coreServerENV.JWT_ISSUER`) — they must **never** read `process.env` themselves, and should prefer the app-level object over reaching into `packages/*.environment.ts` directly once that app has one.

## Rules

- **Built with `tsdown`, exports `./dist/index.mjs`.** Node refuses to type-strip `.ts` files that
  live under `node_modules`; a package consumed as raw source only works while pnpm's symlink keeps
  it outside `node_modules`, in the workspace itself. Any packaging step that materializes the
  files — `pnpm deploy`, and therefore any container image — puts them inside `node_modules`, where
  that symlink no longer helps. Build before consuming as a dependency; `tsdown.config.ts` mirrors
  `packages/cache`'s.
- Env loading at runtime uses `@dotenvx/dotenvx` from the root (`pnpm with-env …`); this package only defines and validates the schema.

## Commands

```bash
pnpm --filter @ruguin/env test:unit
pnpm --filter @ruguin/env check:types
```

## Dependencies

`@t3-oss/env-core`, `zod`.
