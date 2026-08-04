import { defineConfig } from '@ruguin/eslint-config'

/*
 * NestJS modules are decorator-only classes with no members by design (@ruguin/core-server's
 * eslint.config.ts disables this rule for the same reason) — no-extraneous-class flags every
 * `@Module()`/`@Controller()` class this app declares.
 */
export default defineConfig(
  {},
  {
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off'
    }
  }
)
