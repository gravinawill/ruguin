import { failure, success } from '@ruguin/utils'

import {
  CacheLockOutcome,
  CacheSource,
  type GetOrSetCacheProviderDTO,
  type IAcquireLockProvider,
  type IGetCacheProvider,
  type IGetOrSetCacheProvider,
  type IReleaseLockProvider,
  type ISetCacheProvider
} from '../domain'

import { type OnCacheError } from './on-cache-error'

type CacheRead<T> = Readonly<{ found: boolean; value: T | null }>

/*
 * How long a caller queues for the fill lock before giving up and loading anyway, and how
 * often it retries within that budget. These have to be named: with no wait at all, whoever
 * loses the race skips straight to the loader, the post-lock re-read never fires, and the
 * stampede protection this class exists for is inert under exactly the contention it targets.
 */
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 3000
const LOCK_POLL_INTERVAL_MS = 50

export class GetOrSetCacheProvider implements IGetOrSetCacheProvider {
  private readonly reader: IGetCacheProvider
  private readonly writer: ISetCacheProvider
  private readonly lockAcquirer: IAcquireLockProvider
  private readonly lockReleaser: IReleaseLockProvider
  private readonly negativeTtlInMs: number
  private readonly lockTtlInMs: number
  private readonly onCacheError: OnCacheError

  constructor(input: {
    reader: IGetCacheProvider
    writer: ISetCacheProvider
    lockAcquirer: IAcquireLockProvider
    lockReleaser: IReleaseLockProvider
    negativeTtlInMs: number
    lockTtlInMs: number
    onCacheError: OnCacheError
  }) {
    this.reader = input.reader
    this.writer = input.writer
    this.lockAcquirer = input.lockAcquirer
    this.lockReleaser = input.lockReleaser
    this.negativeTtlInMs = input.negativeTtlInMs
    this.lockTtlInMs = input.lockTtlInMs
    this.onCacheError = input.onCacheError
  }

  public async getOrSet<T, E>(input: GetOrSetCacheProviderDTO.Input<T, E>): GetOrSetCacheProviderDTO.Output<T, E> {
    if (input.forceRefresh !== true) {
      const cached: CacheRead<T> | null = await this.read<T, E>(input)

      /*
       * Spelled out rather than read from the variable below: this path returns before the lock
       * logic, so no attempt was made even when the caller asked for one.
       */
      if (cached?.found === true) {
        return success({ value: cached.value, source: CacheSource.CACHE, lockOutcome: CacheLockOutcome.NOT_ATTEMPTED })
      }
    }

    let lockToken: string | null = null
    let lockOutcome: CacheLockOutcome = CacheLockOutcome.NOT_ATTEMPTED

    if (input.lock?.enabled === true) {
      lockToken = await this.acquire(input)
      lockOutcome = lockToken === null ? CacheLockOutcome.NOT_ACQUIRED : CacheLockOutcome.ACQUIRED

      if (lockToken !== null && input.forceRefresh !== true) {
        /*
         * Someone else may have filled the key while we queued for the lock. Without this
         * second read every queued caller would run the loader in turn, trading a parallel
         * stampede for a serial one.
         */
        const refreshed: CacheRead<T> | null = await this.read<T, E>(input)
        if (refreshed?.found === true) {
          await this.release({ input, token: lockToken })
          return success({ value: refreshed.value, source: CacheSource.CACHE, lockOutcome })
        }
      }
    }

    try {
      const loaded = await input.loader()

      /*
       * Not `return loaded`: Failure<E, T | null> is not assignable to Failure<E, OutputSuccess<T>>,
       * because Either carries the success type in its type-guard signatures. Rewrap.
       */
      if (loaded.isFailure()) return failure(loaded.value)

      await this.write({ input, value: loaded.value })

      return success({ value: loaded.value, source: CacheSource.LOADER, lockOutcome })
    } finally {
      if (lockToken !== null) await this.release({ input, token: lockToken })
    }
  }

  private async read<T, E>(input: GetOrSetCacheProviderDTO.Input<T, E>): Promise<CacheRead<T> | null> {
    const result = await this.reader.get<T>({
      key: input.key,
      namespace: input.namespace,
      ...(input.consistency !== undefined && { consistency: input.consistency }),
      ...(input.validate !== undefined && { validate: input.validate })
    })

    // Fail-open: a cache outage must never surface as a failure of getOrSet.
    if (result.isFailure()) {
      this.report({ operation: 'get', input, error: result.value })
      return null
    }

    return result.value
  }

  private async write<T, E>(context: { input: GetOrSetCacheProviderDTO.Input<T, E>; value: T | null }): Promise<void> {
    const ttlInMs: number | undefined =
      context.value === null ? (context.input.negativeTtlInMs ?? this.negativeTtlInMs) : context.input.ttlInMs

    const result = await this.writer.set<T | null>({
      key: context.input.key,
      namespace: context.input.namespace,
      value: context.value,
      ...(ttlInMs !== undefined && { ttlInMs })
    })

    if (result.isFailure()) this.report({ operation: 'set', input: context.input, error: result.value })
  }

  private async acquire<T, E>(input: GetOrSetCacheProviderDTO.Input<T, E>): Promise<string | null> {
    /*
     * The budget goes down verbatim. It used to become `ceil(waitTimeout / pollInterval)`
     * attempts, which silently changed what the caller asked for: an attempt count only equals
     * a wait when attempts are free, and against Valkey each one is a round trip. The driver is
     * the only layer that knows that cost, so it is the layer that spends the budget.
     */
    const result = await this.lockAcquirer.acquire({
      key: input.key,
      namespace: input.namespace,
      ttlInMs: this.lockTtlInMs,
      wait: {
        timeoutInMs: input.lock?.waitTimeoutInMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS,
        pollIntervalInMs: LOCK_POLL_INTERVAL_MS
      }
    })

    // A lock we could not take is not fatal: being slow beats being stuck.
    if (result.isFailure()) {
      this.report({ operation: 'acquire', input, error: result.value })
      return null
    }

    return result.value.token
  }

  private async release<T, E>(context: { input: GetOrSetCacheProviderDTO.Input<T, E>; token: string }): Promise<void> {
    const result = await this.lockReleaser.release({
      key: context.input.key,
      namespace: context.input.namespace,
      token: context.token
    })

    if (result.isFailure()) this.report({ operation: 'release', input: context.input, error: result.value })
  }

  private report<T, E>(context: {
    operation: string
    input: GetOrSetCacheProviderDTO.Input<T, E>
    error: unknown
  }): void {
    this.onCacheError({
      operation: context.operation,
      namespace: context.input.namespace,
      key: context.input.key,
      error: context.error
    })
  }
}
