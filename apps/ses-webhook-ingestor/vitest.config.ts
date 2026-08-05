import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

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
       * Same reasoning as apps/core-server/vitest.config.ts: main.ts, *.module.ts and the health
       * controller are process/app bootstrap wiring only a live listener exercises meaningfully —
       * health.controller.ts already has its own *.e2e.ts covering it.
       */
      exclude: [
        '**/generated/**',
        'src/main.ts',
        'src/**/*.module.ts',
        'src/health/health.controller.ts',
        'src/**/__tests__/**',
        '**/*.config.ts',
        'dist/**'
      ]
    },
    /*
     * Same reasoning as apps/dispatch-worker/vitest.config.ts: integration/e2e files each boot
     * their own AppModule against the same real Kafka broker with hardcoded consumer group IDs —
     * two module instances racing in the same group would split partitions and cause cross-file
     * misses. Serializing files avoids that; unit tests dominate the file count so the cost is low.
     */
    fileParallelism: false,
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/__tests__/**/*.unit.ts'], testTimeout: 5000 } },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/__tests__/**/*.int.ts'],
          setupFiles: ['./vitest.setup.ts'],
          testTimeout: 20_000
        }
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['src/**/__tests__/**/*.e2e.ts'],
          setupFiles: ['./vitest.setup.ts'],
          testTimeout: 30_000
        }
      }
    ]
  }
})
