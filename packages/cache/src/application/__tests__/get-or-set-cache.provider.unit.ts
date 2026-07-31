import { type Either, failure, success } from '@ruguin/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  type AcquireLockProviderDTO,
  CacheConnectionError,
  CacheLockOutcome,
  CacheSource,
  type IAcquireLockProvider,
  type IGetCacheProvider,
  type IReleaseLockProvider,
  type ISetCacheProvider,
  LockNotAcquiredError,
  LockNotOwnedError
} from '../../domain'
import { MemoryCacheDriver } from '../../infra/drivers/memory'
import { KeyBuilder } from '../../infra/key-builder'
import { JsonSerializerStrategy } from '../../infra/serializers'
import { GetOrSetCacheProvider } from '../get-or-set-cache.provider'
import { type OnCacheError } from '../on-cache-error'

type Reported = Parameters<OnCacheError>[0]

const recordingErrorHandler = (): { onCacheError: OnCacheError; reports: Reported[] } => {
  const reports: Reported[] = []

  return {
    onCacheError: (report) => {
      reports.push(report)
    },
    reports
  }
}

const buildDriver = async (): Promise<MemoryCacheDriver> => {
  const driver = new MemoryCacheDriver({
    keyBuilder: new KeyBuilder({ prefix: 'ruguin:test' }),
    serializer: new JsonSerializerStrategy(),
    defaultTtlInMs: 60_000,
    jitterRatio: 0
  })
  await driver.connect()

  return driver
}

const buildProvider = (input: {
  reader: IGetCacheProvider
  writer: ISetCacheProvider
  lockAcquirer: IAcquireLockProvider
  lockReleaser: IReleaseLockProvider
  onCacheError?: OnCacheError
}): GetOrSetCacheProvider =>
  new GetOrSetCacheProvider({
    ...input,
    negativeTtlInMs: 30_000,
    lockTtlInMs: 5000,
    /*
     * Required by the constructor on purpose: swallowing cache errors has to be a decision
     * someone makes, not the path of least resistance.
     */
    onCacheError: input.onCacheError ?? ((): void => undefined)
  })

describe('GetOrSetCacheProvider', () => {
  it('runs the loader on a miss and serves the cache on the next call', async () => {
    const driver = await buildDriver()
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: driver
    })
    const loader = vi.fn((): Promise<Either<Error, string>> => Promise.resolve(success('fresh')))

    const first = await provider.getOrSet<string, Error>({ key: '1', namespace: 'user', loader })
    const second = await provider.getOrSet<string, Error>({ key: '1', namespace: 'user', loader })

    if (first.isFailure() || second.isFailure()) throw new Error('expected success')
    expect(first.value).toEqual({
      value: 'fresh',
      source: CacheSource.LOADER,
      lockOutcome: CacheLockOutcome.NOT_ATTEMPTED
    })
    expect(second.value).toEqual({
      value: 'fresh',
      source: CacheSource.CACHE,
      lockOutcome: CacheLockOutcome.NOT_ATTEMPTED
    })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('caches a null result so a missing record does not hammer the source', async () => {
    const driver = await buildDriver()
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: driver
    })
    const loader = vi.fn((): Promise<Either<Error, string | null>> => Promise.resolve(success(null)))

    await provider.getOrSet<string, Error>({ key: 'ghost', namespace: 'user', loader })
    const second = await provider.getOrSet<string, Error>({ key: 'ghost', namespace: 'user', loader })

    if (second.isFailure()) throw new Error('expected success')
    expect(second.value).toEqual({
      value: null,
      source: CacheSource.CACHE,
      lockOutcome: CacheLockOutcome.NOT_ATTEMPTED
    })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('propagates only the loader failure', async () => {
    const driver = await buildDriver()
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: driver
    })
    const boom = new Error('database down')

    const result = await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      loader: () => Promise.resolve(failure(boom))
    })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBe(boom)
  })

  it('serves the loader when the cache read fails, and reports the error out of band', async () => {
    const driver = await buildDriver()
    const brokenReader: IGetCacheProvider = {
      get: () => Promise.resolve(failure(new CacheConnectionError({ operation: 'get' })))
    }
    const { onCacheError, reports } = recordingErrorHandler()
    const provider = buildProvider({
      reader: brokenReader,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: driver,
      onCacheError
    })

    const result = await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      loader: () => Promise.resolve(success('fresh'))
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value).toEqual({
      value: 'fresh',
      source: CacheSource.LOADER,
      lockOutcome: CacheLockOutcome.NOT_ATTEMPTED
    })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toEqual({
      operation: 'get',
      namespace: 'user',
      key: '1',
      error: expect.any(CacheConnectionError)
    })
  })

  it('names the failing operation, so a broken read is distinguishable from a broken write', async () => {
    const driver = await buildDriver()
    const brokenWriter: ISetCacheProvider = {
      set: () => Promise.resolve(failure(new CacheConnectionError({ operation: 'set' })))
    }
    const { onCacheError, reports } = recordingErrorHandler()
    const provider = buildProvider({
      reader: driver,
      writer: brokenWriter,
      lockAcquirer: driver,
      lockReleaser: driver,
      onCacheError
    })

    await provider.getOrSet<string, Error>({
      key: 'orders',
      namespace: 'billing',
      loader: () => Promise.resolve(success('fresh'))
    })

    /*
     * The whole point of the context: the reader is healthy here and the writer is not, and the
     * report has to say so on its own. A bare `unknown` would leave a logger reaching for
     * `instanceof` plus message parsing to reach the same conclusion.
     */
    expect(reports).toEqual([
      { operation: 'set', namespace: 'billing', key: 'orders', error: expect.any(CacheConnectionError) }
    ])
  })

  it('attributes a lock failure to acquire, on the key that was being filled', async () => {
    const driver = await buildDriver()
    const busyLock: IAcquireLockProvider = {
      acquire: () => Promise.resolve(failure(new LockNotAcquiredError({ lockKey: 'x', attempts: 1 })))
    }
    const { onCacheError, reports } = recordingErrorHandler()
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: busyLock,
      lockReleaser: driver,
      onCacheError
    })

    await provider.getOrSet<string, Error>({
      key: 'orders',
      namespace: 'billing',
      lock: { enabled: true },
      loader: () => Promise.resolve(success('fresh'))
    })

    expect(reports).toEqual([
      { operation: 'acquire', namespace: 'billing', key: 'orders', error: expect.any(LockNotAcquiredError) }
    ])
  })

  it('attributes a failed release to release', async () => {
    const driver = await buildDriver()
    const brokenReleaser: IReleaseLockProvider = {
      release: () => Promise.resolve(failure(new LockNotOwnedError({ lockKey: 'x' })))
    }
    const { onCacheError, reports } = recordingErrorHandler()
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: brokenReleaser,
      onCacheError
    })

    await provider.getOrSet<string, Error>({
      key: 'orders',
      namespace: 'billing',
      lock: { enabled: true },
      loader: () => Promise.resolve(success('fresh'))
    })

    expect(reports).toEqual([
      { operation: 'release', namespace: 'billing', key: 'orders', error: expect.any(LockNotOwnedError) }
    ])
  })

  it('still returns the value when the cache write fails', async () => {
    const driver = await buildDriver()
    const brokenWriter: ISetCacheProvider = {
      set: () => Promise.resolve(failure(new CacheConnectionError({ operation: 'set' })))
    }
    const provider = buildProvider({
      reader: driver,
      writer: brokenWriter,
      lockAcquirer: driver,
      lockReleaser: driver
    })

    const result = await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      loader: () => Promise.resolve(success('fresh'))
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toBe('fresh')
  })

  it('re-reads after taking the lock so queued callers do not all hit the source', async () => {
    const driver = await buildDriver()
    let reads = 0
    const reader: IGetCacheProvider = {
      get: <T>() => {
        reads += 1
        // First read misses; by the time the lock is held another worker has filled it.
        if (reads === 1) return Promise.resolve(success({ found: false, value: null }))
        return Promise.resolve(success({ found: true, value: 'filled-by-someone-else' as T }))
      }
    }
    const loader = vi.fn((): Promise<Either<Error, string>> => Promise.resolve(success('mine')))
    const provider = buildProvider({
      reader,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: driver
    })

    const result = await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      lock: { enabled: true },
      loader
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value).toEqual({
      value: 'filled-by-someone-else',
      source: CacheSource.CACHE,
      lockOutcome: CacheLockOutcome.ACQUIRED
    })
    expect(loader).not.toHaveBeenCalled()
  })

  it('asks for a 3s lock wait budget polled every 50ms', async () => {
    const driver = await buildDriver()
    const retries: Array<AcquireLockProviderDTO.Input['retry']> = []
    const countingLock: IAcquireLockProvider = {
      acquire: (input) => {
        retries.push(input.retry)
        return Promise.resolve(failure(new LockNotAcquiredError({ lockKey: input.key, attempts: 1 })))
      }
    }
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: countingLock,
      lockReleaser: driver
    })

    await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      lock: { enabled: true },
      loader: () => Promise.resolve(success('fresh'))
    })

    /*
     * Pinned rather than merely "more than one attempt": with no wait budget the caller
     * never queues, the post-lock re-read never fires, and the stampede protection is inert
     * under exactly the contention it targets. 3000ms / 50ms is that budget, spelled out.
     */
    expect(retries[0]).toEqual({ attempts: 60, delayInMs: 50 })
  })

  it('runs the loader anyway when the lock cannot be taken', async () => {
    const driver = await buildDriver()
    const busyLock: IAcquireLockProvider = {
      acquire: () => Promise.resolve(failure(new LockNotAcquiredError({ lockKey: 'x', attempts: 1 })))
    }
    const loader = vi.fn((): Promise<Either<Error, string>> => Promise.resolve(success('fresh')))
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: busyLock,
      lockReleaser: driver
    })

    const result = await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      lock: { enabled: true },
      loader
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toBe('fresh')
    expect(loader).toHaveBeenCalledTimes(1)
  })

  describe('lock outcome reporting', () => {
    it('reports NOT_ACQUIRED when the loader ran without the protection the caller asked for', async () => {
      const driver = await buildDriver()
      const busyLock: IAcquireLockProvider = {
        acquire: () => Promise.resolve(failure(new LockNotAcquiredError({ lockKey: 'x', attempts: 1 })))
      }
      const provider = buildProvider({
        reader: driver,
        writer: driver,
        lockAcquirer: busyLock,
        lockReleaser: driver
      })

      const result = await provider.getOrSet<string, Error>({
        key: '1',
        namespace: 'user',
        lock: { enabled: true },
        loader: () => Promise.resolve(success('fresh'))
      })

      /*
       * Without this the degraded run is indistinguishable from a clean one: same value, same
       * source, and getOrSet is fail-open so nothing reaches the error channel either.
       */
      if (result.isFailure()) throw new Error('expected success')
      expect(result.value.lockOutcome).toBe(CacheLockOutcome.NOT_ACQUIRED)
      expect(result.value.source).toBe(CacheSource.LOADER)
    })

    it('reports ACQUIRED when the lock was held for the loader', async () => {
      const driver = await buildDriver()
      const provider = buildProvider({
        reader: driver,
        writer: driver,
        lockAcquirer: driver,
        lockReleaser: driver
      })

      const result = await provider.getOrSet<string, Error>({
        key: '1',
        namespace: 'user',
        lock: { enabled: true },
        loader: () => Promise.resolve(success('fresh'))
      })

      if (result.isFailure()) throw new Error('expected success')
      expect(result.value.lockOutcome).toBe(CacheLockOutcome.ACQUIRED)
    })

    it('separates "no lock was attempted" from "the lock was refused"', async () => {
      const driver = await buildDriver()
      const provider = buildProvider({
        reader: driver,
        writer: driver,
        lockAcquirer: driver,
        lockReleaser: driver
      })

      const unlocked = await provider.getOrSet<string, Error>({
        key: '1',
        namespace: 'user',
        loader: () => Promise.resolve(success('fresh'))
      })
      const servedFromCacheDespiteAskingForTheLock = await provider.getOrSet<string, Error>({
        key: '1',
        namespace: 'user',
        lock: { enabled: true },
        loader: () => Promise.resolve(success('unused'))
      })

      /*
       * Both are the healthy case, and a plain boolean would have flattened them into the same
       * `false` as the degraded run above — making any alert counting failures fire on every
       * ordinary unlocked read. A cache hit short-circuits before the lock logic, so it reports
       * NOT_ATTEMPTED even though the caller did ask; `source` says which case it was.
       */
      if (unlocked.isFailure() || servedFromCacheDespiteAskingForTheLock.isFailure()) {
        throw new Error('expected success')
      }
      expect(unlocked.value.lockOutcome).toBe(CacheLockOutcome.NOT_ATTEMPTED)
      expect(servedFromCacheDespiteAskingForTheLock.value).toEqual({
        value: 'fresh',
        source: CacheSource.CACHE,
        lockOutcome: CacheLockOutcome.NOT_ATTEMPTED
      })
    })
  })

  it('releases the lock even when the loader fails', async () => {
    const driver = await buildDriver()
    const released: string[] = []
    const releaser: IReleaseLockProvider = {
      release: (input) => {
        released.push(input.key)
        return Promise.resolve(success({ released: true }))
      }
    }
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: releaser
    })

    await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      lock: { enabled: true },
      loader: () => Promise.resolve(failure(new Error('boom')))
    })

    expect(released).toEqual(['1'])
  })

  it('skips the read and refreshes the cache when forceRefresh is set', async () => {
    const driver = await buildDriver()
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: driver
    })

    await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      loader: () => Promise.resolve(success('old'))
    })
    const refreshed = await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      forceRefresh: true,
      loader: () => Promise.resolve(success('new'))
    })
    const afterwards = await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      loader: () => Promise.resolve(success('unused'))
    })

    if (refreshed.isFailure() || afterwards.isFailure()) throw new Error('expected success')
    expect(refreshed.value).toEqual({
      value: 'new',
      source: CacheSource.LOADER,
      lockOutcome: CacheLockOutcome.NOT_ATTEMPTED
    })
    expect(afterwards.value).toEqual({
      value: 'new',
      source: CacheSource.CACHE,
      lockOutcome: CacheLockOutcome.NOT_ATTEMPTED
    })
  })

  it('treats a value rejected by validate as a miss and reloads', async () => {
    const driver = await buildDriver()
    const provider = buildProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: driver
    })

    await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      loader: () => Promise.resolve(success('old-shape'))
    })
    const result = await provider.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      validate: (value) => value === 'new-shape',
      loader: () => Promise.resolve(success('new-shape'))
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value).toEqual({
      value: 'new-shape',
      source: CacheSource.LOADER,
      lockOutcome: CacheLockOutcome.NOT_ATTEMPTED
    })
  })

  describe('negative caching ttl', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('expires the cached null after negativeTtlInMs, not after the driver default ttl', async () => {
      const driver = await buildDriver()
      const provider = buildProvider({
        reader: driver,
        writer: driver,
        lockAcquirer: driver,
        lockReleaser: driver
      })
      const loader = vi.fn((): Promise<Either<Error, string | null>> => Promise.resolve(success(null)))

      await provider.getOrSet<string, Error>({ key: 'ghost', namespace: 'user', loader })

      /*
       * Past the provider's negativeTtlInMs (30s) but still well inside the driver's
       * defaultTtlInMs (60s). If write() ever used the regular ttl for a null value, the
       * sentinel would still be alive here and the loader would not run again.
       */
      vi.advanceTimersByTime(30_001)

      const afterNegativeTtl = await provider.getOrSet<string, Error>({ key: 'ghost', namespace: 'user', loader })

      if (afterNegativeTtl.isFailure()) throw new Error('expected success')
      expect(afterNegativeTtl.value).toEqual({
        value: null,
        source: CacheSource.LOADER,
        lockOutcome: CacheLockOutcome.NOT_ATTEMPTED
      })
      expect(loader).toHaveBeenCalledTimes(2)
    })

    it('honors a per-call negativeTtlInMs override for the cached null', async () => {
      const driver = await buildDriver()
      const provider = buildProvider({
        reader: driver,
        writer: driver,
        lockAcquirer: driver,
        lockReleaser: driver
      })
      const loader = vi.fn((): Promise<Either<Error, string | null>> => Promise.resolve(success(null)))

      await provider.getOrSet<string, Error>({ key: 'ghost', namespace: 'user', negativeTtlInMs: 5000, loader })

      // Past the 5s override but well inside the provider's default 30s negativeTtlInMs.
      vi.advanceTimersByTime(5001)

      const afterOverrideTtl = await provider.getOrSet<string, Error>({ key: 'ghost', namespace: 'user', loader })

      if (afterOverrideTtl.isFailure()) throw new Error('expected success')
      expect(afterOverrideTtl.value).toEqual({
        value: null,
        source: CacheSource.LOADER,
        lockOutcome: CacheLockOutcome.NOT_ATTEMPTED
      })
      expect(loader).toHaveBeenCalledTimes(2)
    })
  })
})
