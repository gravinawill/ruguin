import { failure, success } from '@ruguin/utils'

import {
  CacheSource,
  type GetOrSetCacheProviderDTO,
  type IAcquireLockProvider,
  type IGetCacheProvider,
  type IGetOrSetCacheProvider,
  type IReleaseLockProvider,
  type ISetCacheProvider
} from '../domain'

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
  private readonly onCacheError: (error: unknown) => void

  constructor(input: {
    reader: IGetCacheProvider
    writer: ISetCacheProvider
    lockAcquirer: IAcquireLockProvider
    lockReleaser: IReleaseLockProvider
    negativeTtlInMs: number
    lockTtlInMs: number
    onCacheError: (error: unknown) => void
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
      if (cached?.found === true) return success({ value: cached.value, source: CacheSource.CACHE })
    }

    let lockToken: string | null = null

    if (input.lock?.enabled === true) {
      lockToken = await this.acquire(input)

      if (lockToken !== null && input.forceRefresh !== true) {
        /*
         * Someone else may have filled the key while we queued for the lock. Without this
         * second read every queued caller would run the loader in turn, trading a parallel
         * stampede for a serial one.
         */
        const refreshed: CacheRead<T> | null = await this.read<T, E>(input)
        if (refreshed?.found === true) {
          await this.release({ input, token: lockToken })
          return success({ value: refreshed.value, source: CacheSource.CACHE })
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

      return success({ value: loaded.value, source: CacheSource.LOADER })
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
      this.onCacheError(result.value)
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

    if (result.isFailure()) this.onCacheError(result.value)
  }

  private async acquire<T, E>(input: GetOrSetCacheProviderDTO.Input<T, E>): Promise<string | null> {
    const waitTimeoutInMs: number = input.lock?.waitTimeoutInMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS
    const attempts: number = Math.max(1, Math.ceil(waitTimeoutInMs / LOCK_POLL_INTERVAL_MS))

    const result = await this.lockAcquirer.acquire({
      key: input.key,
      namespace: input.namespace,
      ttlInMs: this.lockTtlInMs,
      retry: { attempts, delayInMs: LOCK_POLL_INTERVAL_MS }
    })

    // A lock we could not take is not fatal: being slow beats being stuck.
    if (result.isFailure()) {
      this.onCacheError(result.value)
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

    if (result.isFailure()) this.onCacheError(result.value)
  }
}
