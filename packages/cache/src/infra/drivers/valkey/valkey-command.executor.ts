import { type Either, failure, success } from '@ruguin/utils'

import { CacheConnectionError, CacheTimeoutError } from '../../../domain'

export type ValkeyCommandOutput<T> = Promise<Either<CacheConnectionError | CacheTimeoutError, T>>

/*
 * Resolved rather than rejected by the timer, so the race has a single failure channel and the
 * timeout branch needs no second `catch`. A rejecting timer would also force an unused
 * `resolve` parameter on the executor's promise, which this repo's lint bans outright.
 */
const TIMED_OUT: unique symbol = Symbol('valkey-command-timed-out')

/*
 * The one place a raw client rejection becomes a domain error. Every operation funnels through
 * it so the mapping is uniform: without it each of the twenty-odd commands would invent its own
 * translation and the first one written differently would leak an `ioredis` error into a caller
 * that only knows how to switch on ours.
 */
export class ValkeyCommandExecutor {
  private readonly timeoutInMs: number

  constructor(input: { timeoutInMs: number }) {
    this.timeoutInMs = input.timeoutInMs
  }

  public async run<T>(input: {
    command: () => Promise<T>
    operation: string
    timeoutInMs?: number
  }): ValkeyCommandOutput<T> {
    const budgetInMs: number = input.timeoutInMs ?? this.timeoutInMs

    let timer: ReturnType<typeof setTimeout> | undefined

    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        resolve(TIMED_OUT)
      }, budgetInMs)
    })

    try {
      const outcome: T | typeof TIMED_OUT = await Promise.race([input.command(), deadline])

      if (outcome === TIMED_OUT) {
        return failure(new CacheTimeoutError({ operation: input.operation, timeoutInMs: budgetInMs }))
      }

      return success(outcome)
    } catch (error: unknown) {
      return failure(new CacheConnectionError({ operation: input.operation, error }))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
