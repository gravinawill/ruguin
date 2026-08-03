import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.unit.ts'],
    clearMocks: true,
    restoreMocks: true,
    reporters: ['verbose'],
    testTimeout: 5000,
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
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
       * 2026-08-03: initial floor. Missing coverage: database.environment.ts and
       * server.environment.ts have no dedicated unit test of their own (server.environment.ts is
       * only exercised indirectly, through core-server's pino-http-options tests, which don't
       * count here), and lazy-environment.ts's getOwnPropertyDescriptor trap never sees a
       * property absent from the built env object, so its `descriptor === undefined` branch is
       * untested.
       * This number only goes up — lowering it to make CI pass means the change is incomplete.
       */
      thresholds: {
        statements: 83,
        branches: 75,
        functions: 90,
        lines: 83
      }
    }
  }
})
