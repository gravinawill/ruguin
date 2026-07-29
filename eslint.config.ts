import { defineConfig } from '@ruguin/eslint-config'

export default defineConfig({
  ignores: [
    // Workspace packages carry their own ESLint config.
    'apps/**',
    'packages/**',
    'configs/**',
    '**/coverage/**',
    // Vendored tooling / generated content — not ours to lint (mirrors .prettierignore).
    '.claude/**',
    '.claude-flow/**',
    '.agents/**',
    '.cursor/**',
    '.kiro/**',
    '**/generated/**'
  ]
})
