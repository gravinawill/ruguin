import { type Either, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { ExecuteWithLockProvider } from '../../../../application/index.ts'
import {
  CacheDriver,
  CacheHealthStatus,
  type ICacheDriver,
  LockNotAcquiredError,
  LockNotOwnedError
} from '../../../../domain/index.ts'
import { NoopCacheDriver } from '../noop-cache.driver.ts'

describe('NoopCacheDriver', () => {
  // Typed as the contract it exists to satisfy, the same way a consumer would inject it.
  const provider: ICacheDriver = new NoopCacheDriver()

  it('always misses on read', async () => {
    const result = await provider.get<string>({ key: 'a', namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toBeNull()
  })

  it('accepts a write and discards it', async () => {
    const written = await provider.set({ key: 'a', namespace: 'user', value: 'v', ttlInMs: 1000 })
    const read = await provider.get<string>({ key: 'a', namespace: 'user' })

    expect(written.isSuccess()).toBe(true)
    if (read.isFailure()) throw new Error('expected success')
    expect(read.value.value).toBeNull()
  })

  it('refuses every lock, since it coordinates nothing', async () => {
    const result = await provider.acquire({ key: 'a', namespace: 'user', ttlInMs: 1000 })

    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBeInstanceOf(LockNotAcquiredError)
    expect(result.value.message).toContain('noop:user:__lock__:a')
  })

  it('reports that nothing was released, because nothing was ever held', async () => {
    const result = await provider.release({ key: 'a', namespace: 'user', token: 'whatever' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.released).toBe(false)
  })

  it('refuses to extend, since there is no expiry it could honestly report', async () => {
    const result = await provider.extend({ key: 'a', namespace: 'user', token: 'whatever', ttlInMs: 1000 })

    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBeInstanceOf(LockNotOwnedError)
  })

  it('makes executeWithLock refuse rather than run the task unprotected', async () => {
    const task = vi.fn((): Promise<Either<Error, string>> => Promise.resolve(success('should not run')))
    const orchestrator = new ExecuteWithLockProvider({
      lockAcquirer: provider,
      lockReleaser: provider,
      onCacheError: (): void => undefined
    })

    const result = await orchestrator.executeWithLock<string, Error>({
      key: 'a',
      namespace: 'user',
      ttlInMs: 1000,
      task
    })

    /*
     * The regression this pins: while the driver granted every lock, CACHE_DRIVER=noop turned
     * the one operation that refuses to fail open into a silent no-op — every concurrent caller
     * ran the task in parallel and every one of them was told it had exclusive access.
     */
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBeInstanceOf(LockNotAcquiredError)
    expect(task).not.toHaveBeenCalled()
  })

  it('reports itself as healthy', async () => {
    const result = await provider.healthCheck()

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.status).toBe(CacheHealthStatus.HEALTHY)
    expect(result.value.driver).toBe(CacheDriver.NOOP)
    expect(result.value.replicas).toEqual([])
  })

  it('counts from zero on every increment because nothing persists', async () => {
    await provider.increment({ key: 'hits', namespace: 'rate' })
    const second = await provider.increment({ key: 'hits', namespace: 'rate' })

    if (second.isFailure()) throw new Error('expected success')
    expect(second.value.value).toBe(0)
  })
})
