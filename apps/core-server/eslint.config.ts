import { defineConfig } from '@ruguin/eslint-config'

export default defineConfig(
  { ignores: ['src/generated/**'] },
  {
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off'
    }
  }
)
