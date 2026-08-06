import { defineConfig } from '@ruguin/eslint-config'

export default defineConfig(
  { ignores: ['src/shared/infrastructure/database/prisma/generated/**'] },
  {
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off'
    }
  },
  {
    files: ['**/infrastructure/http/**/*.ts', '**/presentation/controllers/**/*.ts'],
    rules: {
      /*
       * BaseError (@ruguin/shared-domain) deliberately does not extend Error — every controller
       * and guard at the HTTP boundary throws it on purpose, caught by BaseErrorExceptionFilter.
       * Scoped to exactly the two layers that do this; nowhere else in the app throws a BaseError.
       */
      '@typescript-eslint/only-throw-error': 'off'
    }
  }
)
