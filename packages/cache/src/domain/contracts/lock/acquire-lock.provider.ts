import { type Either } from '@ruguin/utils'

import { type CacheOperationError, type LockNotAcquiredError } from '../../errors'

export namespace AcquireLockProviderDTO {
  /*
   * How long the caller is willing to queue for the lock: a budget the driver spends against a
   * real clock, never an attempt count.
   *
   * The distinction is the whole point of the shape. An attempt count makes the caller pay for
   * what an attempt costs: against a network driver every attempt is a round trip, so
   * `ceil(3000 / 50)` attempts 50ms apart takes 3000ms of sleeping *plus* 60 round trips — and
   * a caller who asked for 3s waits far longer exactly when the cache is degraded and the round
   * trips are slowest.
   *
   * The driver owns the waiting because only it knows what an attempt costs. It bases
   * `timeoutInMs` at entry, must not begin an attempt once the budget is spent, and must not
   * sleep past the deadline. `pollIntervalInMs` is the gap between attempts, and a driver that
   * can wait on a notification instead of polling is free to ignore it: the budget is the
   * contract, the polling is a hint.
   */
  export type Wait = Readonly<{ timeoutInMs: number; pollIntervalInMs: number }>

  export type Input = Readonly<{
    key: string
    namespace: string
    ttlInMs: number

    // Omitted means no waiting: one attempt, then give up.
    wait?: Wait
  }>

  export type OutputError = Readonly<CacheOperationError | LockNotAcquiredError>
  export type OutputSuccess = Readonly<{ token: string; expiresAt: Date }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IAcquireLockProvider {
  acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output
}
