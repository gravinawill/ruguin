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
      /*
       * 2026-08-03: initial floor. Missing coverage in id.value-object.ts: ID.generate's
       * non-Error branch of the catch (a thrown non-Error value) and the instanceof guard
       * in ID#equals are untested.
       * This number only goes up — lowering it to make CI pass means the change is incomplete.
       */
      thresholds: {
        statements: 96,
        branches: 78,
        functions: 100,
        lines: 100
      }
    }
  }
})
