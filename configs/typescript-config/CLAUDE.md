# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

## Purpose

`@ruguin/typescript-config` — shared `tsconfig` presets extended by every workspace via `"extends": "@ruguin/typescript-config/base.json"` (or a variant). Published (MIT, `publishConfig.access: public`).

## Structure

Plain JSON files (no `src/`, **no build step**) — published as-is via the `files` allowlist:

```
base.json            # strict base — the common preset all others build on
nestjs.json          # NestJS apps
nextjs.json          # Next.js apps
react-library.json   # React component libraries
```

## What `base.json` enforces

Full `strict` mode plus extras worth knowing before you write types:
`noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `isolatedModules`, `moduleResolution: "Bundler"`, `module`/`target: ESNext`, `verbatimModuleSyntax`-friendly `type` imports. Decorators are enabled (`experimentalDecorators` + `emitDecoratorMetadata`) for the NestJS path.

Because `noUncheckedIndexedAccess` is on, indexing (`arr[i]`, destructured `[a, b] = str.split(...)`) yields `T | undefined` — guard before use. This is why the codebase checks split results everywhere.

## How to use / change

- New workspace: create a local `tsconfig.json` with `"extends": "@ruguin/typescript-config/<preset>.json"` and add only path/include overrides.
- Changing a compiler option repo-wide: edit `base.json`. There's nothing to build — consumers pick it up immediately. If you add a new preset file, add its filename to `package.json` `files`.

## Commands

No build. Type-check happens in each consuming package: `pnpm --filter <pkg> check:types` (`tsc --noEmit`).
