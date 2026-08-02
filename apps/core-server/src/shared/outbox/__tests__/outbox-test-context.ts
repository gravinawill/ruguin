import { PrismaService } from '../../database/prisma.service'

/*
 * Reads a dedicated variable, never the app's own DATABASE_URL: this suite is destructive
 * (deleteMany, raw partition DROP TABLE), so pointing DATABASE_URL at a shared or CI database
 * must never redirect it here too.
 */
export const TEST_DATABASE_URL: string =
  process.env.TEST_DATABASE_URL ?? 'postgresql://ruguin:ruguin@localhost:5432/ruguin?schema=core_server'

export const createTestPrismaService = (): PrismaService => new PrismaService(TEST_DATABASE_URL)

export const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const RELAY_UNTIL_POLL_INTERVAL_MS = 100
const RELAY_UNTIL_DEFAULT_TIMEOUT_MS = 10_000

/*
 * Ticks the relay repeatedly until `done` reports true, instead of sleeping for a duration
 * computed by hand. A fixed sleep has to out-wait the backoff by a margin measured against two
 * different clocks (the app's, which writes nextAttemptAt, and Postgres's, which the relay
 * compares it to) — on a container with any clock drift, or a loaded CI runner, that margin can
 * come up short. Polling finishes as soon as the condition is true and fails with a clear message
 * instead of an assertion mismatch if it never is.
 */
export const relayUntil = async (
  relay: { relay: () => Promise<void> },
  done: () => Promise<boolean>,
  timeoutMs = RELAY_UNTIL_DEFAULT_TIMEOUT_MS
): Promise<void> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    await relay.relay()
    if (await done()) return
    await sleep(RELAY_UNTIL_POLL_INTERVAL_MS)
  }

  throw new Error('relayUntil timed out')
}
