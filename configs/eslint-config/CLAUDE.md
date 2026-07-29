# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

## Purpose

`@ruguin/eslint-config` — the shared **ESLint flat config** for the monorepo. Every app/package consumes it via `@ruguin/eslint-config` (`workspace:*`). Publishable (MIT, `publishConfig.access: public`).

## Structure

```
src/
  index.ts          # barrel: exports base, globs, types
  base.ts           # composes the flat-config array from src/configs/*
  configs/          # one file per rule domain — javascript, typescript, react, jsx,
                    #   nextjs, node, imports, import-sort, comments, command, de-morgan,
                    #   regexp, sonarjs, stylistic, tailwindcss, unicorn, vitest,
                    #   playwright, prettier, gitignore, ignores
  plugins.ts        # plugin instances
  globs.ts          # shared file-glob constants
  types.ts          # config-builder types
  global.d.ts
```

## How to change lint rules

- Edit the relevant `src/configs/<domain>.ts` (e.g. TypeScript rules → `typescript.ts`), not consumers.
- New rule domain → add `src/configs/<name>.ts` and wire it into `base.ts`.
- Prettier is integrated via `eslint-plugin-prettier` (`configs/prettier.ts`); formatting conflicts are turned off with `eslint-config-prettier`. Don't re-add stylistic rules Prettier already owns.

## Build requirement

Built with **tsdown** to `dist/` (`main`/`types` → `dist/index.d.mts`/`index.mjs`; only `dist` is published). Run `pnpm --filter @ruguin/eslint-config build` (or `dev` for watch) after edits, then re-lint consumers. Turborepo rebuilds it as an upstream dependency of `check:lint`.

## Commands

```bash
pnpm --filter @ruguin/eslint-config build
pnpm --filter @ruguin/eslint-config dev        # tsdown --watch
```

Consumers run `eslint . --max-warnings 0` (via each package's `check:lint`) — **zero warnings allowed**, so treat every warning as an error.
