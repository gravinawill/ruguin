import { failure, success } from '@ruguin/utils'
import { describe, expect, it } from 'vitest'

import {
  CacheConnectionError,
  type GetCacheProviderDTO,
  type InvalidateNamespaceProviderDTO,
  type SetCacheProviderDTO
} from '../../../domain'
import { NoopCacheDriver } from '../../drivers/noop/noop-cache.driver'
import { CircuitBreakerState } from '../circuit-breaker'
import { ResilientCacheProvider } from '../resilient-cache.provider'

/*
 * Built on the noop driver so only the methods under test have to be spelled out: every other
 * leaf already answers in the shape ICacheDriver demands.
 */
class FailingDriver extends NoopCacheDriver {
  public calls = 0

  public override get<T>(): GetCacheProviderDTO.Output<T> {
    this.calls += 1

    return Promise.resolve(failure(new CacheConnectionError({ operation: 'get' })))
  }

  public override set(): SetCacheProviderDTO.Output {
    this.calls += 1

    return Promise.resolve(failure(new CacheConnectionError({ operation: 'set' })))
  }

  public override invalidateNamespace(): InvalidateNamespaceProviderDTO.Output {
    this.calls += 1

    return Promise.resolve(failure(new CacheConnectionError({ operation: 'invalidateNamespace' })))
  }
}

class CountingDriver extends NoopCacheDriver {
  public calls = 0

  public override get<T>(): GetCacheProviderDTO.Output<T> {
    this.calls += 1

    return Promise.resolve(success({ found: false, value: null as T | null }))
  }
}

const resilient = (input: { inner: NoopCacheDriver }): ResilientCacheProvider =>
  new ResilientCacheProvider({ failureThreshold: 2, inner: input.inner, resetTimeoutInMs: 10_000 })

describe('ResilientCacheProvider', () => {
  it('delegates while the circuit is closed', async () => {
    const inner = new CountingDriver()
    const provider = resilient({ inner })

    await provider.get({ key: 'a', namespace: 'user' })

    expect(inner.calls).toBe(1)
    expect(provider.state()).toBe(CircuitBreakerState.CLOSED)
  })

  /*
   * The point of the breaker: without it, fail-open still makes every request wait out the
   * connection timeout before falling through to the loader — the cache being down makes the API
   * slow rather than merely uncached.
   */
  it('stops touching the driver at all once the threshold is reached', async () => {
    const inner = new FailingDriver()
    const provider = resilient({ inner })

    await provider.get({ key: 'a', namespace: 'user' })
    await provider.get({ key: 'a', namespace: 'user' })
    expect(provider.state()).toBe(CircuitBreakerState.OPEN)

    const skipped = await provider.get({ key: 'a', namespace: 'user' })

    expect(inner.calls).toBe(2)
    if (skipped.isFailure()) throw new Error('expected a miss, not a failure')
    expect(skipped.value).toEqual({ found: false, value: null })
  })

  it('turns writes into no-ops while open, because the source of truth still holds the value', async () => {
    const inner = new FailingDriver()
    const provider = resilient({ inner })

    await provider.set({ key: 'a', namespace: 'user', value: 1 })
    await provider.set({ key: 'a', namespace: 'user', value: 1 })

    const skipped = await provider.set({ key: 'a', namespace: 'user', value: 1 })

    expect(inner.calls).toBe(2)
    expect(skipped.isSuccess()).toBe(true)
  })

  /*
   * Locks are the one operation that must not fail open. A token handed out while the breaker is
   * skipping I/O would let every concurrent caller of executeWithLock run its task and each be
   * told it held the lock exclusively.
   */
  it('refuses locks while open instead of inventing mutual exclusion', async () => {
    const inner = new FailingDriver()
    const provider = resilient({ inner })

    await provider.get({ key: 'a', namespace: 'user' })
    await provider.get({ key: 'a', namespace: 'user' })

    const acquired = await provider.acquire({ key: 'a', namespace: 'user', ttlInMs: 1000 })

    if (acquired.isSuccess()) throw new Error('expected failure')
    expect(acquired.value.name).toBe('LockNotAcquiredError')
  })

  /*
   * Never short-circuited: answering "invalidated" without touching the server is the one lie the
   * breaker cannot afford, because other instances keep serving the version this call was meant
   * to retire and the caller has been told otherwise.
   */
  it('always sends invalidateNamespace to the driver, even while open', async () => {
    const inner = new FailingDriver()
    const provider = resilient({ inner })

    await provider.invalidateNamespace({ namespace: 'user' })
    await provider.invalidateNamespace({ namespace: 'user' })
    expect(provider.state()).toBe(CircuitBreakerState.OPEN)

    const third = await provider.invalidateNamespace({ namespace: 'user' })

    expect(inner.calls).toBe(3)
    expect(third.isFailure()).toBe(true)
  })

  /*
   * The health check is the report that has to stay true: short-circuiting it would let the
   * breaker hide the very outage it is reacting to.
   */
  it('always sends healthCheck to the driver', async () => {
    const inner = new FailingDriver()
    const provider = resilient({ inner })

    await provider.get({ key: 'a', namespace: 'user' })
    await provider.get({ key: 'a', namespace: 'user' })

    const health = await provider.healthCheck()

    expect(health.isSuccess()).toBe(true)
  })
})
