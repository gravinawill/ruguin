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
    reporters: ['verbose'],
    passWithNoTests: true,
    /*
     * Same reasoning as apps/dispatch-worker/vitest.config.ts: integration/e2e files each boot
     * their own AppModule against the same real Kafka broker with hardcoded consumer group IDs —
     * two module instances racing in the same group would split partitions and cause cross-file
     * misses. Serializing files avoids that; unit tests dominate the file count so the cost is low.
     */
    fileParallelism: false,
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/__tests__/**/*.unit.ts'], testTimeout: 5000 } },
      { extends: true, test: { name: 'integration', include: ['src/**/__tests__/**/*.int.ts'], testTimeout: 20_000 } },
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
