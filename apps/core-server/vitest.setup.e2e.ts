import { runSeedAndCaptureIds } from './prisma/run-seed.ts'

/*
 * A globalSetup file (not setupFiles — see vitest.config.ts's e2e project) must export `setup`,
 * `teardown`, or a default function; Vitest throws otherwise. runSeedAndCaptureIds() runs exactly
 * once for the entire `vitest run --project e2e` invocation; the env vars it writes to
 * process.env are still visible to every test file because Vitest's worker pool spawns after
 * global setup finishes and inherits process.env at that point.
 */
export function setup(): void {
  runSeedAndCaptureIds()
}
