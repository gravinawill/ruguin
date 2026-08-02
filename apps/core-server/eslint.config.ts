import { defineConfig } from '@ruguin/eslint-config'

export default defineConfig(
  { ignores: ['src/shared/infrastructure/database/prisma/generated/**'] },
  {
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off'
    }
  }
)
