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
    reporters: ['verbose'],
    passWithNoTests: true,
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
