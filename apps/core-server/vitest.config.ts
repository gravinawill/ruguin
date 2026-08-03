import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

/*
 * Kept in sync with apps/core-server/.swcrc — both the Nest build and the Vitest
 * transform need decorator metadata enabled, or NestJS DI breaks under test.
 */
const swcPlugin = swc.vite({
  module: { type: 'es6' },
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: 'es2022',
    keepClassNames: true
  }
})

export default defineConfig({
  /*
   * `oxc: false` disables Vite's built-in Rolldown/Oxc TS transform (unplugin-swc only
   * disables the older `esbuild` option, which Vite 8 no longer honors), so SWC is the
   * sole TypeScript transform across every project below and decorator metadata isn't
   * confounded by Oxc's own support.
   */
  oxc: false,
  plugins: [swcPlugin],
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
       * tracing.ts, bootstrap/ and health.controller.ts join main.ts and *.module.ts in this list
       * for the same reason: process/app bootstrap wiring that only a live listener can exercise
       * meaningfully — each already has its own *.e2e.ts covering it.
       */
      exclude: [
        '**/generated/**',
        'src/main.ts',
        'src/tracing.ts',
        'src/**/*.module.ts',
        'src/shared/infrastructure/bootstrap/**',
        'src/modules/health/health.controller.ts',
        'src/**/__tests__/**',
        '**/*.config.ts',
        'scripts/**',
        'dist/**'
      ],
      /*
       * 2026-08-03: initial floor, measured on the unit project after the excludes above.
       * Missing: prisma.service.ts (the PrismaService class itself — constructor and
       * onModuleDestroy need a real connection, so only resolveSchemaFrom is unit-tested),
       * database-health.indicator.ts (the empty-message-after-trim branch),
       * pino-http-options.ts (the no-error, non-4xx/5xx branch of customLogLevel) and
       * transaction-manager.contract.ts (its TRANSACTION_MANAGER DI token is only value-imported
       * by the excluded database module, never by a unit test).
       * This number only goes up — lowering it to make CI pass means the change is incomplete.
       */
      thresholds: {
        statements: 91,
        branches: 93,
        functions: 87,
        lines: 92
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
          testTimeout: 15_000,
          /*
           * The outbox .int.ts suites share one Postgres database/schema and one outbox_messages
           * table — OutboxRelayService publishes rows that other suites' partition/retention
           * assertions depend on, so files in this project must not run concurrently.
           */
          fileParallelism: false
        }
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['src/**/__tests__/**/*.e2e.ts'],
          setupFiles: ['./vitest.setup.e2e.ts'],
          testTimeout: 30_000
        }
      }
    ]
  }
})
