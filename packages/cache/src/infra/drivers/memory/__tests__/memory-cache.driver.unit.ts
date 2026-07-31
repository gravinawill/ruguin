import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type AcquireLockProviderDTO, CacheDriver, CacheHealthStatus, InvalidCacheKeyError } from '../../../../domain'
import { KeyBuilder } from '../../../key-builder'
import { JsonSerializerStrategy } from '../../../serializers'
import { MemoryCacheDriver } from '../memory-cache.driver'

const buildDriver = (input: { jitterRatio?: number } = {}): MemoryCacheDriver =>
  new MemoryCacheDriver({
    keyBuilder: new KeyBuilder({ prefix: 'ruguin:test' }),
    serializer: new JsonSerializerStrategy(),
    defaultTtlInMs: 300_000,
    jitterRatio: input.jitterRatio ?? 0
  })

describe('MemoryCacheDriver', () => {
  let driver: MemoryCacheDriver

  beforeEach(async () => {
    vi.useFakeTimers()
    driver = buildDriver()
    await driver.connect()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('round-trips a value through set and get', async () => {
    await driver.set({ key: '1', namespace: 'user', value: { id: '1' }, ttlInMs: 1000 })
    const result = await driver.get<{ id: string }>({ key: '1', namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toEqual({ id: '1' })
  })

  it('misses once the ttl elapses', async () => {
    await driver.set({ key: '1', namespace: 'user', value: 'v', ttlInMs: 1000 })
    vi.advanceTimersByTime(1001)
    const result = await driver.get<string>({ key: '1', namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toBeNull()
  })

  it('distinguishes a miss from a deliberately cached null', async () => {
    const miss = await driver.get<string>({ key: 'absent', namespace: 'user' })

    if (miss.isFailure()) throw new Error('expected success')
    expect(miss.value).toEqual({ found: false, value: null })

    await driver.set({ key: 'known-absent', namespace: 'user', value: null, ttlInMs: 1000 })
    const negative = await driver.get<string>({ key: 'known-absent', namespace: 'user' })

    if (negative.isFailure()) throw new Error('expected success')
    expect(negative.value).toEqual({ found: true, value: null })
  })

  it('applies the default ttl when the caller omits one', async () => {
    await driver.set({ key: '1', namespace: 'user', value: 'v' })
    vi.advanceTimersByTime(299_999)
    const before = await driver.get<string>({ key: '1', namespace: 'user' })
    vi.advanceTimersByTime(2)
    const after = await driver.get<string>({ key: '1', namespace: 'user' })

    if (before.isFailure() || after.isFailure()) throw new Error('expected success')
    expect(before.value.value).toBe('v')
    expect(after.value.value).toBeNull()
  })

  it('treats a value rejected by validate as a miss', async () => {
    await driver.set({ key: '1', namespace: 'user', value: { legacy: true }, ttlInMs: 1000 })
    const result = await driver.get<{ id: string }>({
      key: '1',
      namespace: 'user',
      validate: (value) => typeof value === 'object' && value !== null && 'id' in value
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toBeNull()
  })

  it('rejects an invalid key before touching the store', async () => {
    const result = await driver.get({ key: 'bad key', namespace: 'user' })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBeInstanceOf(InvalidCacheKeyError)
  })

  it('evicts a corrupt entry on read so the next write can take the key back', async () => {
    await driver.set({ key: '1', namespace: 'user', value: 'v', ttlInMs: 60_000 })

    const physicalKey = 'ruguin:test:user:v1:1'
    driver.store.setValue({ key: physicalKey, serialized: '{not json', ttlInMs: 60_000 })

    const corrupt = await driver.get<string>({ key: '1', namespace: 'user' })

    if (corrupt.isFailure()) throw new Error('expected success')
    expect(corrupt.value).toEqual({ found: false, value: null })

    // Without the eviction the broken payload would sit there re-failing until the TTL ran out.
    expect(driver.store.getValue({ key: physicalKey })).toBeNull()
  })

  it('makes every key under a namespace unreachable once it is invalidated', async () => {
    await driver.set({ key: '1', namespace: 'user', value: 'v', ttlInMs: 60_000 })
    await driver.set({ key: '2', namespace: 'user', value: 'w', ttlInMs: 60_000 })
    await driver.set({ key: '1', namespace: 'order', value: 'kept', ttlInMs: 60_000 })

    const bumped = await driver.invalidateNamespace({ namespace: 'user' })

    if (bumped.isFailure()) throw new Error('expected success')
    expect(bumped.value.version).toBe(2)

    const first = await driver.get<string>({ key: '1', namespace: 'user' })
    const second = await driver.get<string>({ key: '2', namespace: 'user' })
    const untouched = await driver.get<string>({ key: '1', namespace: 'order' })

    if (first.isFailure() || second.isFailure() || untouched.isFailure()) throw new Error('expected success')
    expect(first.value.value).toBeNull()
    expect(second.value.value).toBeNull()
    expect(untouched.value.value).toBe('kept')
  })

  it('stores only the first idempotency key', async () => {
    const first = await driver.setIfNotExists({ key: 'evt-1', namespace: 'webhook', value: 'a', ttlInMs: 1000 })
    const second = await driver.setIfNotExists({ key: 'evt-1', namespace: 'webhook', value: 'b', ttlInMs: 1000 })

    if (first.isFailure() || second.isFailure()) throw new Error('expected success')
    expect(first.value.stored).toBe(true)
    expect(second.value.stored).toBe(false)
  })

  it('counts within a namespace', async () => {
    await driver.increment({ key: 'ip-1', namespace: 'rate', windowInMs: 60_000 })
    const second = await driver.increment({ key: 'ip-1', namespace: 'rate', by: 2 })
    const read = await driver.getCounter({ key: 'ip-1', namespace: 'rate' })

    if (second.isFailure() || read.isFailure()) throw new Error('expected success')
    expect(second.value.value).toBe(3)
    expect(read.value.value).toBe(3)
  })

  it('resets the counter a fixed windowInMs after the first increment, however often it is passed', async () => {
    await driver.increment({ key: 'ip-2', namespace: 'rate', windowInMs: 60_000 })
    vi.advanceTimersByTime(59_000)

    /*
     * Passing the window again mid-flight must not push the expiry out: that is why it is not
     * called ttlInMs. A caller who renews on every call would expect a count of 2 at t=120s.
     */
    await driver.increment({ key: 'ip-2', namespace: 'rate', windowInMs: 60_000 })
    const beforeReset = await driver.getCounter({ key: 'ip-2', namespace: 'rate' })

    vi.advanceTimersByTime(1001)
    const afterReset = await driver.getCounter({ key: 'ip-2', namespace: 'rate' })

    if (beforeReset.isFailure() || afterReset.isFailure()) throw new Error('expected success')
    expect(beforeReset.value.value).toBe(2)
    expect(afterReset.value.value).toBe(0)
  })

  it('holds a lock against a second caller and releases it only for the owner', async () => {
    const first = await driver.acquire({ key: 'job', namespace: 'lock', ttlInMs: 5000 })
    const second = await driver.acquire({ key: 'job', namespace: 'lock', ttlInMs: 5000 })

    if (first.isFailure()) throw new Error('expected success')
    expect(second.isFailure()).toBe(true)

    const stolen = await driver.release({ key: 'job', namespace: 'lock', token: 'not-mine' })
    expect(stolen.isFailure()).toBe(true)

    const released = await driver.release({ key: 'job', namespace: 'lock', token: first.value.token })
    expect(released.isSuccess()).toBe(true)
  })

  it('gives up on a busy lock exactly when the wait budget runs out', async () => {
    await driver.acquire({ key: 'job', namespace: 'lock', ttlInMs: 5000 })

    const startedAt: number = Date.now()

    /*
     * Recorded when the call settles rather than after advancing, because advancing the fake
     * clock moves it whether the driver waited or not — reading Date.now() afterwards would
     * assert nothing. The advance below is deliberately generous so the driver, not the test,
     * decides when to stop.
     */
    let settledAt = -1
    const contended: AcquireLockProviderDTO.Output = (async (): AcquireLockProviderDTO.Output => {
      const acquired = await driver.acquire({
        key: 'job',
        namespace: 'lock',
        ttlInMs: 5000,
        wait: { timeoutInMs: 120, pollIntervalInMs: 50 }
      })
      settledAt = Date.now()

      return acquired
    })()

    await vi.advanceTimersByTimeAsync(1000)
    const result = await contended

    if (result.isSuccess()) throw new Error('expected failure')

    /*
     * 120ms of waiting, not 100ms. A budget converted to `ceil(120 / 50) = 3` attempts spends
     * only the two 50ms gaps between them and abandons the last 20ms the caller asked for;
     * spending against the clock fits a fourth attempt in, on a 20ms nap that lands exactly on
     * the deadline. The count follows from the clock here, never the reverse.
     */
    expect(settledAt - startedAt).toBe(120)
    expect(result.value.message).toContain('4 attempt(s)')
  })

  it('refuses to poll faster than 1ms, so a zero interval cannot hammer the lock', async () => {
    await driver.acquire({ key: 'job', namespace: 'lock', ttlInMs: 5000 })

    const contended = driver.acquire({
      key: 'job',
      namespace: 'lock',
      ttlInMs: 5000,
      wait: { timeoutInMs: 20, pollIntervalInMs: 0 }
    })

    await vi.advanceTimersByTimeAsync(100)
    const result = await contended

    if (result.isSuccess()) throw new Error('expected failure')

    /*
     * The budget bounds elapsed time, not the attempt count — so without a floor, a caller
     * passing 0 turns a wait into a flood: against a network driver a 3s budget would become
     * thousands of round trips on one contended key, the opposite of what the budget is for.
     * 21 is 20ms of 1ms naps plus the attempt that lands on the deadline.
     */
    expect(result.value.message).toContain('21 attempt(s)')
  })

  it('makes a single attempt when no wait budget is given', async () => {
    await driver.acquire({ key: 'job', namespace: 'lock', ttlInMs: 5000 })
    const result = await driver.acquire({ key: 'job', namespace: 'lock', ttlInMs: 5000 })

    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value.message).toContain('1 attempt(s)')
  })

  it('ranks a leaderboard', async () => {
    await driver.setScore({ key: 'weekly', namespace: 'board', member: 'a', score: 10 })
    await driver.incrementScore({ key: 'weekly', namespace: 'board', member: 'b', by: 30 })

    const rank = await driver.getRank({ key: 'weekly', namespace: 'board', member: 'b' })
    const top = await driver.getTopScores({ key: 'weekly', namespace: 'board', limit: 1 })

    if (rank.isFailure() || top.isFailure()) throw new Error('expected success')
    expect(rank.value).toEqual({ rank: 1, total: 2 })
    expect(top.value.entries).toEqual([{ member: 'b', score: 30 }])
  })

  it('refuses to serve reads before connect', async () => {
    const fresh = buildDriver()
    const result = await fresh.get({ key: '1', namespace: 'user' })

    expect(result.isFailure()).toBe(true)
  })

  it('reports itself healthy and names the memory driver', async () => {
    const result = await driver.healthCheck()

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.status).toBe(CacheHealthStatus.HEALTHY)
    expect(result.value.driver).toBe(CacheDriver.MEMORY)
  })

  describe('ttl jitter', () => {
    it('spreads expiresAt across the +/-jitterRatio window instead of landing exactly on the base ttl', async () => {
      const jittered = buildDriver({ jitterRatio: 0.5 })
      await jittered.connect()
      const now = Date.now()

      vi.spyOn(Math, 'random').mockReturnValue(0)
      const low = await jittered.set({ key: 'low', namespace: 'user', value: 'v', ttlInMs: 1000 })

      vi.spyOn(Math, 'random').mockReturnValue(1)
      const high = await jittered.set({ key: 'high', namespace: 'user', value: 'v', ttlInMs: 1000 })

      if (low.isFailure() || high.isFailure()) throw new Error('expected success')
      // base 1000 +/- 50%: random()=0 bottoms out at 500, random()=1 tops out at 1500.
      expect(low.value.expiresAt.getTime()).toBe(now + 500)
      expect(high.value.expiresAt.getTime()).toBe(now + 1500)
    })

    it('leaves the ttl exact when applyJitter is false, even with a jitterRatio configured', async () => {
      const jittered = buildDriver({ jitterRatio: 0.5 })
      await jittered.connect()
      const now = Date.now()

      vi.spyOn(Math, 'random').mockReturnValue(1)
      const result = await jittered.set({
        key: '1',
        namespace: 'user',
        value: 'v',
        ttlInMs: 1000,
        applyJitter: false
      })

      if (result.isFailure()) throw new Error('expected success')
      expect(result.value.expiresAt.getTime()).toBe(now + 1000)
    })
  })
})
