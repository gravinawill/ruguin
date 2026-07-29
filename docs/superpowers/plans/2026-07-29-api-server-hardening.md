# API Server Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `apps/api-server` (NestJS) into conformance with the monorepo's conventions (real ESM, Vitest, shared workspace configs) and add the operational foundation expected of a production service: SWC build, layered Vitest tests + k6 load test, structured logging (Pino), tracing (OpenTelemetry), and a health check (Terminus).

**Architecture:** No new domain modules — this is pure foundation work on the existing scaffold. Each concern (build, tests, logging, tracing, health) is wired independently through NestJS's module system and Node's `--import` hook, so any one of them can be reasoned about or changed without touching the others.

**Tech Stack:** NestJS 11, SWC (`@swc/core`, `@swc/cli`, `unplugin-swc`), Vitest 4 (`vitest`, `@vitest/coverage-v8`), `nestjs-pino` + `pino-http`, `@nestjs/terminus`, OpenTelemetry Node SDK + auto-instrumentation, k6 (Grafana), `@ruguin/utils`.

## Global Constraints

- Node engine: `26.5.0`; package manager: `pnpm@11.17.0` (see root `package.json`).
- `apps/api-server` keeps `"type": "module"` — every relative import in `src/` must end in `.js` (Node ESM resolution requirement at runtime; `moduleResolution: Bundler` in the shared tsconfig only relaxes this for type-checking, not for what Node actually loads).
- SWC must emit decorator metadata identically to `tsc`: `.swcrc`'s `jsc.transform.legacyDecorator: true` and `decoratorMetadata: true` are non-negotiable — without them NestJS dependency injection breaks silently, both at runtime and in Vitest (via `unplugin-swc`, configured the same way).
- No Jest anywhere in `apps/api-server` after this plan — only Vitest (matches `packages/utils`, `packages/message-broker`, and the monorepo root).
- Lint is zero-warnings (`eslint . --max-warnings 0`, per `check:lint` convention) — every new/modified file must pass it.
- `@ruguin/utils` stays a dependency-free leaf package with no build step — do not add a `build` script or `dist/` to it.
- Terminus only checks that the HTTP layer is alive for now — no Postgres/Redis/Kafka indicators (those clients don't exist in the app yet).
- Integration/e2e Vitest projects assume `infrastructure/local/docker-compose.yml` is already running (Postgres `localhost:5432` user/pass/db `ruguin`, Redis/Valkey `localhost:6379`, Kafka `localhost:9092`) — they don't start their own containers.

---

### Task 1: Clean up the scaffold and align with workspace conventions

**Files:**
- Delete: `apps/api-server/.git` (leftover nested repo from `nest new`, never meant to be committed)
- Modify: `apps/api-server/package.json`

**Interfaces:**
- Produces: `check:lint`, `check:types`, `fix:lint`, `clean`, `dev`, `update:deps` scripts matching the `turbo.json` task pipeline (`check:lint`, `check:types`, `fix:lint`, `clean`, `update:deps` all have `dependsOn: ["^<task>"]` entries there, so every workspace package needs a same-named script for `turbo run <task>` to reach it).

- [ ] **Step 1: Remove the nested git repo**

Run: `rm -rf apps/api-server/.git`
Verify: `test -d apps/api-server/.git && echo STILL THERE || echo REMOVED` → expect `REMOVED`.

- [ ] **Step 2: Commit the untouched scaffold baseline (excluding `main.ts`)**

`apps/api-server` is entirely untracked today. Commit it as-is (before any edits) so every later task's diff is a real diff against a tracked baseline, instead of silently leaving whatever files no later task names by path (`tsconfig.json`, `tsconfig.build.json`, `eslint.config.ts`, `README.md`) untracked forever.

**Exclude `src/main.ts` from this commit.** The repo's pre-commit hook (`lint-staged`) runs `eslint --fix` on every staged `.ts` file. `--fix` can auto-fix formatting (prettier, import order) but not `unicorn/prefer-top-level-await` — one of `main.ts`'s pre-existing errors requires restructuring the code, which is exactly what Task 2 does. Committing `main.ts` here would either fail the hook or force committing known-broken code. Leave it untracked for now; Task 2 adds it fresh, already fixed.

```bash
git add apps/api-server -- ':!apps/api-server/src/main.ts'
git status --short  # sanity check: no dist/, node_modules/, or .turbo/ entries (must already be gitignored); main.ts must NOT be staged
git commit -m "chore(api-server): commit nest new scaffold baseline"
```

Expected: `git status --short` before the commit shows only source/config files staged (e.g. `eslint.config.ts`, `nest-cli.json`, `package.json`, `README.md`, `tsconfig.build.json`, `tsconfig.json`, `vitest.config.ts`, `src/app.module.ts`) — no `dist/`, `node_modules/`, `.turbo/`, and no `src/main.ts`. `src/main.ts` remains listed as untracked (`??`) after the commit — that's correct, Task 2 adds it. If any of `dist/`/`node_modules/`/`.turbo/` show up, stop and fix the root `.gitignore` before committing.

- [ ] **Step 3: Rewrite `apps/api-server/package.json`**

Replace the whole file with:

```json
{
  "name": "@ruguin/api-server",
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "build": "nest build",
    "check:lint": "eslint . --max-warnings 0",
    "check:types": "tsc --noEmit --pretty",
    "clean": "rm -rf .claude-flow .swarm .superpowers .remember .gitnexus .turbo coverage node_modules dist build",
    "dev": "nest start --watch",
    "fix:lint": "eslint --fix .",
    "start": "nest start",
    "start:debug": "nest start --debug --watch",
    "start:dev": "nest start --watch",
    "start:prod": "node dist/main",
    "test": "jest",
    "test:cov": "jest --coverage",
    "test:e2e": "jest --config ./test/jest-e2e.json",
    "test:watch": "jest --watch",
    "update:deps": "ncu -u"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.1",
    "@nestjs/core": "^11.0.1",
    "@nestjs/platform-express": "^11.0.1",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.0",
    "@nestjs/schematics": "^11.0.0",
    "@nestjs/testing": "^11.0.1",
    "@ruguin/eslint-config": "workspace:*",
    "@ruguin/prettier-config": "workspace:*",
    "@ruguin/typescript-config": "workspace:*",
    "@types/express": "^5.0.0",
    "@types/jest": "^30.0.0",
    "@types/node": "^26.1.2",
    "@types/supertest": "^7.0.0",
    "jest": "^30.0.0",
    "source-map-support": "^0.5.21",
    "supertest": "^7.0.0",
    "ts-jest": "^29.2.5",
    "ts-loader": "^9.5.2",
    "ts-node": "^10.9.2",
    "tsconfig-paths": "^4.2.0",
    "typescript": "^5.7.3"
  }
}
```

This removes the duplicated `eslint`/`@eslint/js`/`typescript-eslint`/`globals`/`prettier` devDependencies (the app's `eslint.config.ts` already imports `@ruguin/eslint-config`, which wasn't declared anywhere) and the dead `"format"` script (formatting is handled monorepo-wide by the root's `check:format`/`fix:format`, like every other workspace package). Jest itself is untouched here — it's fully replaced in Task 4.

- [ ] **Step 4: Install**

Run: `pnpm install`
Expected: completes without errors; `apps/api-server` now resolves `@ruguin/eslint-config`, `@ruguin/typescript-config`, `@ruguin/prettier-config` from the workspace.

- [ ] **Step 5: Verify type-checking still passes**

Run: `pnpm --filter @ruguin/api-server check:types`
Expected: no output, exit code 0 (already verified clean on the current source).

- [ ] **Step 6: Verify lint config resolves (pre-existing errors in `main.ts` are expected and get fixed in Task 2)**

Run: `pnpm --filter @ruguin/api-server check:lint`
Expected: fails with exactly 7 pre-existing errors, all in `src/main.ts` (import-sort, prettier semicolons, `unicorn/prefer-top-level-await`). `src/app.module.ts` reports zero errors. If any *other* file or a config-resolution error shows up, something is wrong with the workspace dependency wiring — stop and fix before continuing.

- [ ] **Step 7: Commit**

```bash
git add apps/api-server/package.json pnpm-lock.yaml
git commit -m "chore(api-server): align package.json with workspace conventions"
```

---

### Task 2: Real ESM — fix `main.ts` imports and lint

**Files:**
- Create: `apps/api-server/src/main.ts` (left untracked and unstaged by Task 1 specifically so this task's already-fixed content is what first gets committed — see Task 1 Step 2)
- Modify: `apps/api-server/tsconfig.json`
- Modify: `apps/api-server/tsconfig.build.json`

**Interfaces:**
- Consumes: `AppModule` from `./app.module.js` (Task 1's app.module.ts, unchanged in this task)
- Produces: `main.ts` bootstraps the app with a relative import that Node can actually resolve in ESM (`.js` extension), and is lint-clean top-level-await style — later tasks (6, 8) extend this same file. `dist/main.js` is where the compiled entrypoint actually lands — every later task's boot-check and the `start`/`start:prod` scripts depend on that exact path.

- [ ] **Step 1: Rewrite `src/main.ts`**

```ts
import { NestFactory } from '@nestjs/core'

import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)
await app.listen(process.env.PORT ?? 3000)
```

- [ ] **Step 2: Lint check**

Run: `pnpm --filter @ruguin/api-server check:lint`
Expected: 0 errors.

- [ ] **Step 3: Fix `tsconfig.json`'s `rootDir` (pre-existing scaffold bug, discovered while verifying this task)**

`apps/api-server/tsconfig.json` currently sets `"rootDir": "."` (the whole `apps/api-server` directory), while all real source lives under `src/`. Combined with `outDir: "./dist"`, this makes `nest build` mirror the full directory into `dist/`, so the compiled entrypoint ends up at `dist/src/main.js` (not `dist/main.js`, which the `start`/`start:prod` scripts and every later boot-check assume) — and it also compiles `vitest.config.ts`/`eslint.config.ts` into `dist/` for no reason (they're dev-only config, not part of the app).

Rewrite `apps/api-server/tsconfig.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ruguin/typescript-config/nestjs.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  }
}
```

Rewrite `apps/api-server/tsconfig.build.json` (exclude the two config files now that they'd otherwise violate the narrower `rootDir`):

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts", "eslint.config.ts", "vitest.config.ts"]
}
```

- [ ] **Step 4: Build and verify the app actually boots under real ESM resolution**

```bash
rm -rf apps/api-server/dist
pnpm --filter @ruguin/api-server build
find apps/api-server/dist -type f
node apps/api-server/dist/main.js &
API_PID=$!
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000
kill $API_PID
```

Expected: `find` lists only `main.js`/`main.d.ts`/`app.module.js`/`app.module.d.ts` (+ `.map` files) directly under `dist/` — no `dist/src/` nesting, no `vitest.config.js`/`eslint.config.js`. curl prints `404` (Nest's default "Cannot GET /" for the empty `AppModule` — proves the process started and the ESM import resolved; a broken `.js` extension would instead crash with `ERR_MODULE_NOT_FOUND` and curl would fail to connect).

- [ ] **Step 5: Commit**

```bash
git add apps/api-server/src/main.ts apps/api-server/tsconfig.json apps/api-server/tsconfig.build.json
git commit -m "fix(api-server): resolve main.ts import under real ESM; fix dist output layout"
```

---

### Task 3: SWC as the Nest build compiler

**Files:**
- Create: `apps/api-server/.swcrc`
- Modify: `apps/api-server/nest-cli.json`
- Modify: `apps/api-server/tsconfig.json`
- Modify: `apps/api-server/package.json` (devDependencies)
- Modify: `pnpm-workspace.yaml`

**Interfaces:**
- Produces: `nest build`/`nest start` now compile via SWC instead of `tsc`, with decorator metadata preserved — every later task that adds `@Injectable()`/`@Module()` classes (5, 6, 8, 9) depends on this working correctly. `dist/main.js` stays the compiled entrypoint path (same as Task 2) — the SWC builder needs its own fix to keep that true (Step 3 below).

- [ ] **Step 1: Allow `@swc/core`'s install script to run**

`@swc/core` ships a native binding installed via a postinstall script. This pnpm workspace blocks build/postinstall scripts by default (`blockExoticSubdeps`) unless explicitly allow-listed — without this step, `pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS` for `@swc/core` and the build never runs at all.

Rewrite `pnpm-workspace.yaml` (only the `onlyBuiltDependencies` and `allowBuilds` sections change — keep everything else, e.g. `packages`, `blockExoticSubdeps`, as-is):

```yaml
onlyBuiltDependencies:
  - '@swc/core'
  - esbuild
  - unrs-resolver
allowBuilds:
  '@swc/core': true
  esbuild: true
  unrs-resolver: true
```

- [ ] **Step 2: Add SWC devDependencies**

Run: `pnpm add --filter @ruguin/api-server -D @swc/cli @swc/core`
Expected: completes without `ERR_PNPM_IGNORED_BUILDS` (Step 1 already allow-listed it); `apps/api-server/package.json` and the root `pnpm-lock.yaml` both show the new deps — verify with `git diff --stat` before committing later, this exact gap (deps installed locally but never staged) has bitten this task before.

- [ ] **Step 3: Create `apps/api-server/.swcrc`**

```json
{
  "$schema": "https://json.schemastore.org/swcrc",
  "sourceMaps": true,
  "module": {
    "type": "es6"
  },
  "jsc": {
    "parser": {
      "syntax": "typescript",
      "decorators": true
    },
    "transform": {
      "legacyDecorator": true,
      "decoratorMetadata": true
    },
    "target": "es2022",
    "keepClassNames": true
  }
}
```

- [ ] **Step 4: Point `nest-cli.json` at the SWC builder**

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "builder": "swc",
    "typeCheck": true
  }
}
```

`typeCheck: true` keeps a parallel `tsc` type-check running during `nest build`/`nest start --watch` — SWC itself only transpiles, it doesn't catch type errors.

- [ ] **Step 5: Remove `rootDir` from `tsconfig.json` (Task 2's fix, now in conflict with the SWC builder)**

Task 2 set `"rootDir": "./src"` to make the plain `tsc` build land at `dist/main.js` instead of `dist/src/main.js`. NestJS's SWC builder computes its own `stripLeadingPaths` CLI option as `!tsOptions.rootDir` (see `@nestjs/cli/lib/compiler/defaults/swc-defaults.js`) — so an *explicit* `rootDir` flips that to `false` and SWC stops stripping the `src/` prefix, producing `dist/src/main.js` again, just for a different reason than Task 2 fixed.

The correct fix now that SWC is the builder: remove the explicit `rootDir` entirely. TypeScript still infers the same effective root for the parallel type-check/declaration pass, because `tsconfig.build.json` already excludes `eslint.config.ts`/`vitest.config.ts` (Task 2), leaving only `src/**/*.ts` as input — but with `rootDir` no longer literally present in the resolved compiler options, SWC's `stripLeadingPaths` correctly becomes `true`.

Rewrite `apps/api-server/tsconfig.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ruguin/typescript-config/nestjs.json",
  "compilerOptions": {
    "outDir": "./dist"
  }
}
```

- [ ] **Step 6: Build and boot under SWC — this is also the decorator-metadata runtime proof**

```bash
rm -rf apps/api-server/dist
pnpm --filter @ruguin/api-server build
find apps/api-server/dist -type f
node apps/api-server/dist/main.js &
API_PID=$!
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000
kill $API_PID
```

Expected: `find` lists `main.js`/`app.module.js` (+ `.js.map`) directly under `dist/` — no `dist/src/` nesting. curl prints `404`, same as Task 2 — the build now goes through SWC instead of `tsc`, and the app still boots (if `legacyDecorator`/`decoratorMetadata` were misconfigured, `NestFactory.create` would throw a dependency-resolution error here instead of starting).

- [ ] **Step 7: Lint and type-check still pass**

```bash
pnpm --filter @ruguin/api-server check:lint
pnpm --filter @ruguin/api-server check:types
```

Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/api-server/.swcrc apps/api-server/nest-cli.json apps/api-server/tsconfig.json apps/api-server/package.json pnpm-lock.yaml pnpm-workspace.yaml
git status --short  # confirm package.json and pnpm-lock.yaml actually show as staged, not just .swcrc/nest-cli.json
git commit -m "build(api-server): compile with SWC instead of tsc"
```

---

### Task 4: Migrate tests from Jest to Vitest (+ SWC transform for tests)

**Files:**
- Modify: `apps/api-server/vitest.config.ts`
- Modify: `apps/api-server/package.json` (scripts + devDependencies)
- Modify: `apps/api-server/nest-cli.json` (SWC builder needs an `ignore` pattern, or it compiles `*.unit.ts` test files straight into `dist/`)
- Modify: `apps/api-server/tsconfig.build.json` (add `**/*.unit.ts` to `exclude`, alongside the existing `**/*spec.ts` — otherwise the parallel type-check pass tries to compile test files as part of the app build)
- Create: `apps/api-server/src/decorator-metadata.unit.ts`

**Interfaces:**
- Produces: `pnpm --filter @ruguin/api-server test` runs Vitest (not Jest); Vitest's TypeScript transform now goes through the same SWC decorator config as the app build, so any test that instantiates a NestJS-decorated class behaves like production.

- [ ] **Step 1: Write the failing canary test**

Create `apps/api-server/src/decorator-metadata.unit.ts`:

```ts
import 'reflect-metadata'

import { Injectable } from '@nestjs/common'
import { describe, expect, it } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- placeholder DI target, only its type identity matters
class Dependency {}

@Injectable()
class ServiceUnderTest {
  constructor(private readonly dependency: Dependency) {}

  getDependency(): Dependency {
    return this.dependency
  }
}

describe('SWC decorator metadata', () => {
  it('emits design:paramtypes for constructor-injected dependencies', () => {
    // eslint-disable-next-line unicorn/no-nonstandard-builtin-properties -- reflect-metadata polyfill API, not the native Reflect
    const parameterTypes = Reflect.getMetadata('design:paramtypes', ServiceUnderTest) as unknown[]

    expect(parameterTypes).toEqual([Dependency])
  })
})
```

The `getDependency()` method exists only so the strict tsconfig's unused-property check (`TS6138`) doesn't flag the parameter property — it's never called by the test. The two `eslint-disable` comments are both real, narrow rule conflicts in this repo's lint config (an empty placeholder class, and `Reflect.getMetadata` being a `reflect-metadata` polyfill method rather than a native `Reflect` API) — not blanket suppressions.

- [ ] **Step 2: Run it under the current default Vitest transform and confirm it fails**

Run: `pnpm --filter @ruguin/api-server exec vitest run src/decorator-metadata.unit.ts`
Expected: FAIL — `parameterTypes` is `undefined` (esbuild's TypeScript transform doesn't implement `emitDecoratorMetadata`).

**Known deviation (discovered during implementation):** this repo's Vite is "rolldown-vite" (oxc-based, not plain esbuild), and oxc's TS transform already emits decorator metadata — so this step may come back PASS instead of the expected FAIL. If that happens, don't force a failure: proceed to Steps 3+ anyway. The point of `unplugin-swc` was never "make a failing test pass" for its own sake — it's guaranteeing Vitest's transform is deterministically identical to the app's own SWC build config from Task 3, rather than relying on oxc's incidental (and version-fragile) support for the same behavior. Getting a *real* RED in this repo requires explicitly disabling Vite's built-in transform too (see Step 3's `oxc: false` — `unplugin-swc`'s own `esbuild: false` option only disables the older esbuild path, which Vite 8 no longer uses by default). Document whichever result actually happened; don't fabricate a FAIL.

- [ ] **Step 3: Add `unplugin-swc` and wire it into `vitest.config.ts`**

Run: `pnpm add --filter @ruguin/api-server -D unplugin-swc`

Rewrite `apps/api-server/vitest.config.ts`:

```ts
import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  /*
   * Kept in sync with apps/api-server/.swcrc — both the Nest build and the Vitest
   * transform need decorator metadata enabled, or NestJS DI breaks under test.
   * `oxc: false` disables Vite's built-in Rolldown/Oxc TS transform (unplugin-swc only
   * disables the older `esbuild` option, which Vite 8 no longer honors), so SWC is the
   * sole TypeScript transform and the decorator metadata proof isn't confounded by Oxc's own support.
   */
  oxc: false,
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
        keepClassNames: true
      }
    })
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.unit.ts'],
    clearMocks: true,
    restoreMocks: true,
    reporters: ['verbose'],
    testTimeout: 5000,
    passWithNoTests: true
  }
})
```

- [ ] **Step 3b: Keep test files out of the app build**

Two config files need a matching exclusion for `*.unit.ts`, or `nest build` tries to compile the new test file into the app:

Rewrite `apps/api-server/nest-cli.json`:

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "builder": {
      "type": "swc",
      "options": {
        "ignore": ["**/*.spec.ts", "**/*.unit.ts"]
      }
    },
    "typeCheck": true
  }
}
```

Rewrite `apps/api-server/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts", "**/*.unit.ts", "eslint.config.ts", "vitest.config.ts"]
}
```

- [ ] **Step 4: Run the canary test again and confirm it passes**

Run: `pnpm --filter @ruguin/api-server exec vitest run src/decorator-metadata.unit.ts`
Expected: PASS.

- [ ] **Step 5: Remove Jest, add Vitest as a real devDependency, update scripts**

```bash
pnpm remove --filter @ruguin/api-server jest ts-jest ts-loader ts-node tsconfig-paths @types/jest
pnpm add --filter @ruguin/api-server -D vitest @vitest/coverage-v8
```

Update the `scripts` block in `apps/api-server/package.json` to:

```json
"scripts": {
  "build": "nest build",
  "check:lint": "eslint . --max-warnings 0",
  "check:types": "tsc --noEmit --pretty",
  "clean": "rm -rf .claude-flow .swarm .superpowers .remember .gitnexus .turbo coverage node_modules dist build",
  "dev": "nest start --watch",
  "fix:lint": "eslint --fix .",
  "start": "nest start",
  "start:debug": "nest start --debug --watch",
  "start:dev": "nest start --watch",
  "start:prod": "node dist/main",
  "test": "vitest run",
  "test:cov": "vitest run --coverage",
  "test:watch": "vitest",
  "update:deps": "ncu -u"
}
```

(`test:e2e` is dropped here — it comes back correctly scoped in Task 5.)

- [ ] **Step 6: Full test run**

Run: `pnpm --filter @ruguin/api-server test`
Expected: 1 passed (the canary test).

- [ ] **Step 7: Lint and type-check**

```bash
pnpm --filter @ruguin/api-server check:lint
pnpm --filter @ruguin/api-server check:types
```

Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/api-server/vitest.config.ts apps/api-server/package.json apps/api-server/src/decorator-metadata.unit.ts pnpm-lock.yaml
git commit -m "test(api-server): migrate from Jest to Vitest with SWC transform"
```

---

### Task 5: Layer Vitest into unit / integration / e2e projects

**Files:**
- Modify: `apps/api-server/vitest.config.ts`
- Modify: `apps/api-server/package.json` (scripts)

**Interfaces:**
- Consumes: the `swc.vite(...)` plugin config from Task 4 (reused as-is, shared across all projects).
- Produces: three named Vitest projects — `unit` (`src/**/*.unit.ts`), `integration` (`src/**/*.integration.ts`), `e2e` (`src/**/*.e2e.ts`) — that Task 6's health e2e test and any future test files rely on for file-naming/discovery.

- [ ] **Step 1: Rewrite `apps/api-server/vitest.config.ts`**

```ts
import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

/*
 * Kept in sync with apps/api-server/.swcrc — both the Nest build and the Vitest
 * transform need decorator metadata enabled, or NestJS DI breaks under test.
 */
const swcPlugin = swc.vite({
  module: { type: 'es6' },
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: 'es2022',
    keepClassNames: true
  }
})

export default defineConfig({
  /*
   * `oxc: false` disables Vite's built-in Rolldown/Oxc TS transform (unplugin-swc only
   * disables the older `esbuild` option, which Vite 8 no longer honors), so SWC is the
   * sole TypeScript transform across every project below and decorator metadata isn't
   * confounded by Oxc's own support.
   */
  oxc: false,
  plugins: [swcPlugin],
  test: {
    globals: true,
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    reporters: ['verbose'],
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.unit.ts'],
          testTimeout: 5000
        }
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.integration.ts'],
          testTimeout: 15_000
        }
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['src/**/*.e2e.ts'],
          testTimeout: 30_000
        }
      }
    ]
  }
})
```

Notes on this exact shape, confirmed against the installed `vitest@4.1.10`:
- `oxc: false` must carry over from Task 4's `vitest.config.ts` — omitting it here would silently regress the decorator-metadata fix (Vite 8's Oxc/Rolldown transform would re-enable itself).
- `passWithNoTests: true` must live at the **root** `test` config, not inside each project's `test` block — per-project `passWithNoTests` doesn't affect the exit code when running a single `--project` filter (only the root-level flag does).
- `TypeScript` complains under `tsc --noEmit` if `passWithNoTests` is placed inside a project block (`ProjectConfig` doesn't include that field, only the root `InlineConfig` does) — even though it's a silent no-op at runtime, it fails `check:types`.
- `15000`/`30000` need numeric-separator underscores (`15_000`/`30_000`) to satisfy this repo's `unicorn/numeric-separators-style` lint rule.

- [ ] **Step 2: Update scripts to target each project**

Update the `scripts` block in `apps/api-server/package.json`:

```json
"scripts": {
  "build": "nest build",
  "check:lint": "eslint . --max-warnings 0",
  "check:types": "tsc --noEmit --pretty",
  "clean": "rm -rf .claude-flow .swarm .superpowers .remember .gitnexus .turbo coverage node_modules dist build",
  "dev": "nest start --watch",
  "fix:lint": "eslint --fix .",
  "start": "nest start",
  "start:debug": "nest start --debug --watch",
  "start:dev": "nest start --watch",
  "start:prod": "node dist/main",
  "test": "vitest run --project unit",
  "test:all": "vitest run",
  "test:cov": "vitest run --project unit --coverage",
  "test:e2e": "vitest run --project e2e",
  "test:integration": "vitest run --project integration",
  "test:watch": "vitest --project unit",
  "update:deps": "ncu -u"
}
```

- [ ] **Step 3: Verify each project runs independently**

```bash
pnpm --filter @ruguin/api-server test               # unit
pnpm --filter @ruguin/api-server test:integration
pnpm --filter @ruguin/api-server test:e2e
pnpm --filter @ruguin/api-server test:all
```

Expected: `test` reports 1 passed (the Task 4 canary); `test:integration` and `test:e2e` report no test files found but exit 0 (`passWithNoTests: true` — there's genuinely nothing to test at either layer yet: no external-dependency clients exist for integration, and Task 6 adds the first e2e test); `test:all` reports 1 passed, 0 failed across all projects.

- [ ] **Step 4: Commit**

```bash
git add apps/api-server/vitest.config.ts apps/api-server/package.json
git commit -m "test(api-server): split Vitest into unit, integration, and e2e projects"
```

---

### Task 6: Terminus health check

**Files:**
- Create: `apps/api-server/src/health/health.controller.ts`
- Create: `apps/api-server/src/health/health.module.ts`
- Create: `apps/api-server/src/health/health.controller.e2e.ts`
- Modify: `apps/api-server/src/app.module.ts`
- Modify: `apps/api-server/package.json` (dependencies)

**Interfaces:**
- Produces: `GET /health` → `200 { status: 'ok', ... }` when the HTTP layer is up. Task 7's k6 script targets this exact route.

- [ ] **Step 1: Add `@nestjs/terminus`**

Run: `pnpm add --filter @ruguin/api-server @nestjs/terminus`

- [ ] **Step 2: Write the failing e2e test**

Create `apps/api-server/src/health/health.controller.e2e.ts`:

```ts
import type { INestApplication } from '@nestjs/common'

import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AppModule } from '../app.module.js'

describe('GET /health (e2e)', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleReference.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 200 with status ok', async () => {
    const response = await request(app.getHttpServer() as Parameters<typeof request>[0]).get('/health')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ status: 'ok' })
  })
})
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm --filter @ruguin/api-server test:e2e`
Expected: FAIL — `/health` doesn't exist yet, `response.status` is `404`.

- [ ] **Step 4: Create the health module**

`apps/api-server/src/health/health.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common'
import { HealthCheck, HealthCheckService } from '@nestjs/terminus'

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthCheckService) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([])
  }
}
```

`apps/api-server/src/health/health.module.ts`:

```ts
import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'

import { HealthController } from './health.controller.js'

@Module({
  imports: [TerminusModule],
  controllers: [HealthController]
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- this is a module
export class HealthModule {}
```

- [ ] **Step 5: Wire it into `AppModule`**

Rewrite `apps/api-server/src/app.module.ts`:

```ts
import { Module } from '@nestjs/common'

import { HealthModule } from './health/health.module.js'

@Module({
  imports: [HealthModule],
  controllers: [],
  providers: []
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- this is a module
export class AppModule {}
```

- [ ] **Step 6: Run the e2e test again and confirm it passes**

Run: `pnpm --filter @ruguin/api-server test:e2e`
Expected: PASS — `200`, body matches `{ status: 'ok', ... }`.

- [ ] **Step 7: Full check**

```bash
pnpm --filter @ruguin/api-server check:lint
pnpm --filter @ruguin/api-server check:types
pnpm --filter @ruguin/api-server test:all
```

Expected: all pass (2 tests total now: the Task 4 canary + this e2e test).

- [ ] **Step 8: Commit**

```bash
git add apps/api-server/src/health apps/api-server/src/app.module.ts apps/api-server/package.json pnpm-lock.yaml
git commit -m "feat(api-server): add Terminus health check at GET /health"
```

---

### Task 7: k6 load test targeting the health endpoint

**Files:**
- Create: `infrastructure/local/k6/api-server-health.ts`
- Modify: `package.json` (root — new script)

**Interfaces:**
- Consumes: `GET /health` from Task 6, reachable on `localhost:3000` when the api-server is running (`pnpm --filter @ruguin/api-server start:dev` or `start:prod`).

**Environment note:** `infrastructure/local/k6/smoke.ts` and the root `infra:load-test` script (the existing pattern this task mirrors) are, as of this plan, still uncommitted work-in-progress on the main checkout from a separate, concurrent workstream (the local observability stack) — they don't exist anywhere in this branch's git history, since this branch/worktree only contains what was committed at the time it was created. Don't try to diff against them; use the content below verbatim, and place the new root script alphabetically on its own merits. Docker is also not available in every environment this plan might run in — if so, Step 3 can't be executed live; say so plainly in the report rather than fabricating output. Once this branch and the observability work both land on `main`, a follow-up should confirm no naming/placement collision with the real `infra:load-test`/`smoke.ts` once they exist alongside this file.

- [ ] **Step 1: Create `infrastructure/local/k6/api-server-health.ts`**

```ts
import type { Options } from 'k6/options'

import { check, sleep } from 'k6'
import http from 'k6/http'

/*
 * Targets the api-server's Terminus health check. Run the api-server yourself first
 * (`pnpm --filter @ruguin/api-server start:dev`), then `pnpm infra:load-test:api-server`.
 * Override with K6_TARGET_URL to point at a different host/port.
 */
// eslint-disable-next-line unicorn/prefer-https -- local Docker network, no TLS available
const TARGET_URL: string = __ENV.K6_TARGET_URL ?? 'http://host.docker.internal:3000/health'

export const options: Options = {
  vus: 5,
  duration: '10s'
}

export default function test(): void {
  const result = http.get(TARGET_URL)
  check(result, { 'status is 200': (response: unknown) => response.status === 200 })
  sleep(1)
}
```

(`??` instead of `||`, and the inner callback parameter renamed to `response` instead of shadowing the outer `result`, satisfy this repo's root-level `eslint.config.ts` — it lints `infrastructure/**` directly, unlike `apps/**`/`packages/**`/`configs/**` which carry their own configs.)

- [ ] **Step 2: Add the root script**

In the root `package.json` `scripts` block, add in alphabetical order:

```json
"infra:load-test:api-server": "docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.tools.yml run --rm k6 run /scripts/api-server-health.ts",
```

- [ ] **Step 3: Verify against a running api-server (requires Docker)**

In one terminal:
```bash
pnpm infra:up
pnpm --filter @ruguin/api-server start:dev
```

In another terminal, once the app has logged that it's listening:
```bash
pnpm infra:load-test:api-server
```

Expected: k6 summary output with `checks_succeeded: 100.00%` and `http_req_failed: 0.00%`. Stop the `start:dev` process afterward. If Docker isn't available in the current environment, skip this step and report it as not executable there rather than fabricating a result — the file/script content is still fully reviewable without it.

- [ ] **Step 4: Commit**

```bash
git add infrastructure/local/k6/api-server-health.ts package.json
git commit -m "test(infra): add k6 load test for the api-server health endpoint"
```

---

### Task 8: Structured logging with `nestjs-pino`

**Files:**
- Create: `apps/api-server/src/logger/pino-http-options.ts`
- Create: `apps/api-server/src/logger/pino-http-options.unit.ts`
- Modify: `apps/api-server/src/app.module.ts`
- Modify: `apps/api-server/src/main.ts`
- Modify: `apps/api-server/package.json` (dependencies/devDependencies)

**Interfaces:**
- Produces: `createPinoHttpOptions(environment: NodeJS.ProcessEnv): Options` (from `pino-http`) — a pure factory, unit-tested in isolation from Nest's DI/HTTP layers.

- [ ] **Step 1: Add dependencies**

```bash
pnpm add --filter @ruguin/api-server nestjs-pino pino-http
pnpm add --filter @ruguin/api-server -D pino-pretty
```

- [ ] **Step 2: Write the failing unit test**

Create `apps/api-server/src/logger/pino-http-options.unit.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { createPinoHttpOptions } from './pino-http-options.js'

describe('createPinoHttpOptions', () => {
  it('defaults to info level and pretty-prints outside production', () => {
    const options = createPinoHttpOptions({ NODE_ENV: 'development' })

    expect(options.level).toBe('info')
    expect(options.transport).toEqual({ target: 'pino-pretty' })
  })

  it('respects LOG_LEVEL and disables pretty-print in production', () => {
    const options = createPinoHttpOptions({ NODE_ENV: 'production', LOG_LEVEL: 'warn' })

    expect(options.level).toBe('warn')
    expect(options.transport).toBeUndefined()
  })

  it('redacts the authorization header', () => {
    const options = createPinoHttpOptions({})

    expect(options.redact).toContain('req.headers.authorization')
  })
})
```

No `as NodeJS.ProcessEnv` casts on the test's object literals — `NodeJS.ProcessEnv` is an index-signature type, so plain object literals are already assignable to it, and this repo's `@typescript-eslint/no-unnecessary-type-assertion` rule rejects the redundant cast.

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm --filter @ruguin/api-server test`
Expected: FAIL — `pino-http-options.js` doesn't exist (module resolution error).

- [ ] **Step 4: Implement the factory**

Create `apps/api-server/src/logger/pino-http-options.ts`:

```ts
import type { Options } from 'pino-http'

export function createPinoHttpOptions(environment: NodeJS.ProcessEnv): Options {
  const isProduction = environment.NODE_ENV === 'production'

  return {
    level: environment.LOG_LEVEL ?? 'info',
    ...(!isProduction && { transport: { target: 'pino-pretty' } }),
    redact: ['req.headers.authorization']
  }
}
```

Two adaptations from a more obvious first draft, both required by this repo's stricter tooling: the parameter is named `environment`, not `env` (`unicorn/name-replacements` rejects the abbreviation), and the `transport` field is set via a conditional spread rather than `transport: isProduction ? undefined : {...}` — this tsconfig's `exactOptionalPropertyTypes: true` rejects explicitly assigning `undefined` to an optional property (`TS2375`), and `unicorn/consistent-conditional-object-spread` rejects the ternary-spread form too.

- [ ] **Step 5: Run the unit test again and confirm it passes**

Run: `pnpm --filter @ruguin/api-server test`
Expected: PASS (3 new assertions, plus the existing canary and e2e tests still passing under `test:all`).

- [ ] **Step 6: Wire the logger into `AppModule` and `main.ts`**

Rewrite `apps/api-server/src/app.module.ts`:

```ts
import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'

import { HealthModule } from './health/health.module.js'
import { createPinoHttpOptions } from './logger/pino-http-options.js'

@Module({
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => ({ pinoHttp: createPinoHttpOptions(process.env) })
    }),
    HealthModule
  ],
  controllers: [],
  providers: []
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- this is a module
export class AppModule {}
```

Rewrite `apps/api-server/src/main.ts`:

```ts
import { NestFactory } from '@nestjs/core'
import { Logger } from 'nestjs-pino'

import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule, { bufferLogs: true })
app.useLogger(app.get(Logger))
await app.listen(process.env.PORT ?? 3000)
```

- [ ] **Step 7: Verify the app still boots and logs via Pino**

```bash
pnpm --filter @ruguin/api-server build
node apps/api-server/dist/main.js &
API_PID=$!
sleep 1
curl -s http://localhost:3000/health
echo
kill $API_PID
```

Expected: the terminal shows Pino-formatted (pretty-printed, not plain Nest logger) startup logs, and curl prints `{"status":"ok",...}`.

- [ ] **Step 8: Full check**

```bash
pnpm --filter @ruguin/api-server check:lint
pnpm --filter @ruguin/api-server check:types
pnpm --filter @ruguin/api-server test:all
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add apps/api-server/src/logger apps/api-server/src/app.module.ts apps/api-server/src/main.ts apps/api-server/package.json pnpm-lock.yaml
git commit -m "feat(api-server): structured logging via nestjs-pino"
```

---

### Task 9: OpenTelemetry tracing (auto-instrumentation)

**Files:**
- Create: `apps/api-server/src/tracing/create-tracing-sdk.ts`
- Create: `apps/api-server/src/tracing/create-tracing-sdk.unit.ts`
- Create: `apps/api-server/src/tracing.ts`
- Modify: `apps/api-server/package.json` (scripts + dependencies)

**Interfaces:**
- Produces: `resolveOtlpEndpoint(env): string` and `createTracingSdk(env): NodeSDK`, both pure and unit-tested. `src/tracing.ts` is the side-effecting entrypoint loaded via `node --import` before `main.ts`, so auto-instrumentation can patch modules before the app imports them.

- [ ] **Step 1: Add OpenTelemetry dependencies**

```bash
pnpm add --filter @ruguin/api-server @opentelemetry/api @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/sdk-node @opentelemetry/semantic-conventions
```

- [ ] **Step 2: Write the failing unit test**

Create `apps/api-server/src/tracing/create-tracing-sdk.unit.ts`:

```ts
import { NodeSDK } from '@opentelemetry/sdk-node'
import { describe, expect, it } from 'vitest'

import { createTracingSdk, resolveOtlpEndpoint } from './create-tracing-sdk.js'

describe('resolveOtlpEndpoint', () => {
  it('defaults to the local OTel Collector HTTP endpoint', () => {
    expect(resolveOtlpEndpoint({} as NodeJS.ProcessEnv)).toBe('http://localhost:4318/v1/traces')
  })

  it('respects OTEL_EXPORTER_OTLP_ENDPOINT when set', () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/v1/traces' } as NodeJS.ProcessEnv

    expect(resolveOtlpEndpoint(env)).toBe('http://collector:4318/v1/traces')
  })
})

describe('createTracingSdk', () => {
  it('returns a NodeSDK instance', () => {
    const sdk = createTracingSdk({} as NodeJS.ProcessEnv)

    expect(sdk).toBeInstanceOf(NodeSDK)
  })
})
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm --filter @ruguin/api-server test`
Expected: FAIL — `create-tracing-sdk.js` doesn't exist.

- [ ] **Step 4: Implement the factory**

Create `apps/api-server/src/tracing/create-tracing-sdk.ts`:

```ts
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

export function resolveOtlpEndpoint(env: NodeJS.ProcessEnv): string {
  return env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces'
}

export function createTracingSdk(env: NodeJS.ProcessEnv): NodeSDK {
  return new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'api-server' }),
    traceExporter: new OTLPTraceExporter({ url: resolveOtlpEndpoint(env) }),
    instrumentations: [getNodeAutoInstrumentations()]
  })
}
```

- [ ] **Step 5: Run the unit test again and confirm it passes**

Run: `pnpm --filter @ruguin/api-server test`
Expected: PASS.

- [ ] **Step 6: Create the bootstrap entrypoint**

Create `apps/api-server/src/tracing.ts`:

```ts
import { createTracingSdk } from './tracing/create-tracing-sdk.js'

createTracingSdk(process.env).start()
```

- [ ] **Step 7: Wire it into the production start script**

Update `apps/api-server/package.json`'s `start:prod` script:

```json
"start:prod": "node --import ./dist/tracing.js dist/main.js",
```

- [ ] **Step 8: Verify traces reach the local OTel Collector**

Prerequisite: the observability stack from `infrastructure/local/` is up (OTel Collector listening on `4318`).

```bash
pnpm --filter @ruguin/api-server build
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces node --import apps/api-server/dist/tracing.js apps/api-server/dist/main.js &
API_PID=$!
sleep 1
curl -s http://localhost:3000/health
echo
sleep 2
kill $API_PID
```

Expected: curl still returns `{"status":"ok",...}`, and the OTel Collector's own logs (`pnpm infra:logs` or `docker compose -f infrastructure/local/docker-compose.yml logs otel-collector`) show a received trace batch for the `GET /health` request. If the Collector isn't running locally, at minimum confirm the app doesn't crash on boot with `OTEL_SDK_DISABLED=true` set (auto-instrumentation initialized but exporting is skipped).

- [ ] **Step 9: Full check**

```bash
pnpm --filter @ruguin/api-server check:lint
pnpm --filter @ruguin/api-server check:types
pnpm --filter @ruguin/api-server test:all
```

Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add apps/api-server/src/tracing.ts apps/api-server/src/tracing apps/api-server/package.json pnpm-lock.yaml
git commit -m "feat(api-server): OpenTelemetry tracing via auto-instrumentation"
```

---

### Task 10: `@ruguin/utils` dependency + CLAUDE.md convention

**Files:**
- Modify: `apps/api-server/package.json` (dependencies)
- Modify: `/Users/will/dev/public/ruguin/CLAUDE.md`

**Interfaces:**
- None — this is a dependency declaration plus documentation. No production usage is added yet (the app has no domain logic with expected failures to model with `Either`); the convention is documented so the first feature that needs it uses it correctly.

- [ ] **Step 1: Add `@ruguin/utils` as a dependency**

Run: `pnpm add --filter @ruguin/api-server @ruguin/utils@workspace:*`

- [ ] **Step 2: Verify it resolves**

Run: `pnpm --filter @ruguin/api-server check:types`
Expected: exits 0 (nothing imports it yet, so this just confirms the workspace link resolves without error).

- [ ] **Step 3: Document the convention in the root `CLAUDE.md`**

Add a new section to `/Users/will/dev/public/ruguin/CLAUDE.md`, after the existing `## Setup` section (end of file):

```markdown
## Code Conventions

- Prefer `Either`/`Success`/`Failure` from `@ruguin/utils` for expected/domain failures instead of throwing exceptions or inventing ad-hoc result types.
- Check `@ruguin/utils` before adding a new dependency for common functional/utility helpers.
```

- [ ] **Step 4: Commit**

```bash
git add apps/api-server/package.json pnpm-lock.yaml CLAUDE.md
git commit -m "chore(api-server): depend on @ruguin/utils; document Either convention"
```

---

## Self-Review Notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-07-29-api-server-hardening-design.md` maps to a task — §1→Task 1, §2→Task 2, §3→Tasks 3–4, §4→Tasks 5–7, §5→Task 8, §6→Task 9, §7→Task 6, §8→Task 10.
- **Verified against the live repo before writing this plan:** `check:types` passes today on unmodified `apps/api-server`; `check:lint` currently fails with exactly 7 errors, all in `main.ts` (confirmed by running both commands) — Task 1's expected output reflects that reality instead of assuming a clean baseline.
- **Type/name consistency checked across tasks:** `createPinoHttpOptions` (Task 8), `createTracingSdk`/`resolveOtlpEndpoint` (Task 9), `HealthController`/`HealthModule` (Task 6) are each defined once and referenced with matching names/signatures everywhere they're used later (`app.module.ts` in Tasks 6 and 8, `main.ts` in Tasks 2 and 8, `start:prod` in Task 9).
- **No placeholders:** every step has literal file content or an executable command; no step defers behavior to "similar to Task N" or leaves a TBD.
