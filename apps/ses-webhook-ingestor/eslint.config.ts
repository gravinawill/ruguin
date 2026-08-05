import { defineConfig } from '@ruguin/eslint-config'

/*
 * NestJS modules are decorator-only classes with no members by design (see the same override in
 * apps/dispatch-worker/eslint.config.ts and apps/core-server/eslint.config.ts).
 */
export default defineConfig(
  {},
  {
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off'
    }
  }
)
