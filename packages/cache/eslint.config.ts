import { defineConfig } from '@ruguin/eslint-config'

export default defineConfig(
  {},
  {
    /*
     * A @Module() class carries its metadata on the class itself; NestJS has no other place to put
     * it. Scoped to src/nestjs so the rest of the package keeps the rule that made CacheFactory an
     * object literal instead of a class of statics.
     */
    files: ['src/nestjs/**/*.ts'],
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off'
    }
  }
)
