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
      ],
      /*
       * Mirrors packages/{env,ddd-kernel,utils}/vitest.config.ts's own thresholds. apps/core-server
       * and packages/cache aren't listed here: each declares its unit/integration/e2e split via a
       * nested `test.projects`, and Vitest's workspace mechanism does not flatten a member
       * project's own nested projects — they run zero tests under this aggregate command today.
       * Their thresholds are enforced directly by `pnpm --filter <pkg> test:cov` /
       * `test:all --coverage`, verified independently (see task-2-report.md).
       */
      thresholds: {
        'packages/env/src/**': { statements: 83, branches: 75, functions: 90, lines: 83 },
        'packages/ddd-kernel/src/**': { statements: 96, branches: 78, functions: 100, lines: 100 },
        'packages/utils/src/**': { statements: 100, branches: 100, functions: 100, lines: 100 }
      }
    }
  }
})
