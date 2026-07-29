# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

## Purpose

`@ruguin/prettier-config` — the shared **Prettier config** for the monorepo, published as a resolvable module (MIT, `publishConfig.access: public`). Root `prettier` runs against it; ESLint also consumes it through `@ruguin/eslint-config`'s prettier integration.

## Structure

```
src/
  base.ts     # the Prettier Config object (rules, plugins)
  index.ts    # exports base + re-exports the `Config` type from prettier
```

Plugins wired in: `prettier-plugin-packagejson` (sorts `package.json`) and `prettier-plugin-prisma`.

## How to change formatting

Edit `src/base.ts`, rebuild, then run `pnpm fix:format` from the root to reformat the repo. Because Prettier owns formatting, don't add overlapping stylistic rules in `@ruguin/eslint-config`.

## Build requirement

Built with **tsdown** to `dist/` (only `dist` is published). Run `pnpm --filter @ruguin/prettier-config build` (or `dev` for watch) after edits. Turborepo rebuilds it as an upstream dependency where needed.

## Commands

```bash
pnpm --filter @ruguin/prettier-config build
pnpm --filter @ruguin/prettier-config dev      # tsdown --watch

# from repo root:
pnpm check:format    # prettier --check
pnpm fix:format      # prettier --write
```
