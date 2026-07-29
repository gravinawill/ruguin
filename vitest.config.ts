import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /*
     * Discover test projects across every workspace glob (mirrors
     * pnpm-workspace.yaml). `passWithNoTests` keeps `vitest run` green while
     * packages are still being scaffolded and have no tests yet.
     */
    projects: ['apps/*', 'packages/*', 'configs/*'],
    passWithNoTests: true,
    coverage: {
      reporter: ['lcov', 'html', 'json-summary'],
      provider: 'v8',
      include: ['**/src/**/*.{ts,tsx}'],
      exclude: [
        // test files
        '**/tests/**',
        '**/__tests__/**',
        '**/index.ts'
      ]
    }
  }
})
