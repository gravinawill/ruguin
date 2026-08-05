import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    reporters: ['verbose', 'vitest-sonar-reporter'],
    outputFile: { 'vitest-sonar-reporter': './coverage/sonar-report.xml' },
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      /*
       * `include` matters as much as `exclude`: Vitest 4 dropped `coverage.all`, so without it
       * only files a test actually imports are measured — a file nobody imports yet would be
       * invisible to the threshold instead of dragging it down.
       */
      include: ['src/**/*.ts'],
      /*
       * The target is 100% of business code. What's excluded here isn't debt: it's code whose
       * coverage would assert that the language works, not that the rule is right.
       */
      exclude: ['**/generated/**', 'src/**/__tests__/**', '**/*.config.ts', 'dist/**'],
      /*
       * 2026-08-03: initial floor, measured on unit + integration together (test:all).
       * Missing coverage is concentrated in infra/decorators/resilient-cache.provider.ts,
       * infra/drivers/noop/noop-cache.driver.ts and infra/drivers/memory/memory-cache.driver.ts —
       * error-path and edge-case branches with no test yet.
       * This number only goes up — lowering it to make CI pass means the change is incomplete.
       */
      thresholds: {
        statements: 83,
        branches: 75,
        functions: 79,
        lines: 91
      }
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/__tests__/**/*.unit.ts'],
          testTimeout: 5000
        }
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/__tests__/**/*.int.ts'],
          testTimeout: 15_000
        }
      }
    ]
  }
})
