import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /*
     * Discover test projects across every workspace glob (mirrors
     * pnpm-workspace.yaml). `passWithNoTests` keeps `vitest run` green while
     * packages are still being scaffolded and have no tests yet.
     */
    projects: ['apps/*', 'packages/*', 'configs/*', 'scripts'],
    passWithNoTests: true
    /*
     * No `coverage` block here on purpose. A member project's own `test.coverage` is overwritten
     * by this root config (Vitest 4 workspace behavior), and this root config does not flatten a
     * member's nested `test.projects` — so a threshold declared here would silently gate zero
     * files for apps/core-server and packages/cache, the same failure mode this file used to have.
     * Coverage is gated per package instead: each package keeps its own thresholds in its own
     * vitest.config.ts, run via `<pkg> test:cov`; `pnpm test:coverage` fans that out with
     * `turbo run test:cov` so every package's own config actually applies.
     */
  }
})
