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
     * integration/e2e files each boot their own EmailModule instance against the same real Kafka
     * broker, and EmailSendRequestedConsumer/EmailSendRequestedRetryConsumer use hardcoded consumer
     * group IDs (not per-run-unique) — see email-send-requested(-retry).consumer.ts. Two module
     * instances racing in the same group cause Kafka to split partitions between them, so a message
     * one test publishes can be consumed by the *other* test's module instance, whose producer isn't
     * the one being spied/observed on — a silent cross-file miss, not a flake in either test alone.
     * false here serializes every file (fast, since unit tests dominate the file count and cost
     * nothing to run one-at-a-time) so no two EmailModule instances are ever live at once.
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
