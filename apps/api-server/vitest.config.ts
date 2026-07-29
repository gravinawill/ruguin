import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  /*
   * Kept in sync with apps/api-server/.swcrc — both the Nest build and the Vitest
   * transform need decorator metadata enabled, or NestJS DI breaks under test.
   * `oxc: false` disables Vite's built-in Rolldown/Oxc TS transform (unplugin-swc only
   * disables the older `esbuild` option, which Vite 8 no longer honors), so SWC is the
   * sole TypeScript transform and the decorator metadata proof isn't confounded by Oxc's own support.
   */
  oxc: false,
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
        keepClassNames: true
      }
    })
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.unit.ts'],
    clearMocks: true,
    restoreMocks: true,
    reporters: ['verbose'],
    testTimeout: 5000,
    passWithNoTests: true
  }
})
