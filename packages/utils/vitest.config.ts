import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.unit.ts'],
    clearMocks: true,
    restoreMocks: true,
    reporters: ['verbose', 'vitest-sonar-reporter'],
    outputFile: { 'vitest-sonar-reporter': './coverage/sonar-report.xml' },
    testTimeout: 5000,
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
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100
      }
    }
  }
})
