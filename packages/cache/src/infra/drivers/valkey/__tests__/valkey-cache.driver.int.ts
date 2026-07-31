import { success } from '@ruguin/utils'
import { afterEach, describe, expect, it } from 'vitest'

import { CacheConsistency, CacheLockOutcome, CacheSource, type ICacheProvider } from '../../../../domain'

import { createValkeyCache, sleep, uniquePrefix } from './valkey-test-context'

const NAMESPACE = 'user'

const open: ICacheProvider[] = []

const connect = async (input: Parameters<typeof createValkeyCache>[0]): Promise<ICacheProvider> => {
  const { provider } = createValkeyCache(input)
  open.push(provider)

  const connected = await provider.connect()
  if (connected.isFailure()) throw new Error(connected.value.message)

  return provider
}

afterEach(async () => {
  const closing: readonly ICacheProvider[] = [...open]
  open.length = 0

  await Promise.all(closing.map(async (provider) => provider.disconnect()))
})

describe('namespace invalidation against a live Valkey', () => {
  /*
   * Nothing is deleted: the version moves and the old keys become unreachable, which is what makes
   * bulk invalidation O(1) and keeps SCAN out of the package entirely.
   */
  it('makes every key in the namespace unreachable without deleting anything', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'invalidate' }) })

    await provider.set({ key: 'a', namespace: NAMESPACE, value: 1 })
    await provider.set({ key: 'b', namespace: NAMESPACE, value: 2 })

    const bumped = await provider.invalidateNamespace({ namespace: NAMESPACE })
    if (bumped.isFailure()) throw new Error('expected success')
    expect(bumped.value.version).toBe(2)

    const readA = await provider.get({ key: 'a', namespace: NAMESPACE })
    const readB = await provider.get({ key: 'b', namespace: NAMESPACE })

    if (readA.isFailure() || readB.isFailure()) throw new Error('expected success')
    expect(readA.value.found).toBe(false)
    expect(readB.value.found).toBe(false)
  })

  // Absent means version 1, so a bump has to land on 2 — a plain INCR would answer 1 and change nothing.
  it('advances the version even when the namespace was never invalidated before', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'first-bump' }) })

    const before = await provider.resolveNamespaceVersion({ namespace: NAMESPACE })
    const bumped = await provider.invalidateNamespace({ namespace: NAMESPACE })

    if (before.isFailure() || bumped.isFailure()) throw new Error('expected success')
    expect(before.value.version).toBe(1)
    expect(bumped.value.version).toBe(2)
  })

  it('leaves other namespaces untouched', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'scoped' }) })

    await provider.set({ key: 'a', namespace: NAMESPACE, value: 1 })
    await provider.set({ key: 'a', namespace: 'session', value: 2 })

    await provider.invalidateNamespace({ namespace: NAMESPACE })

    const survivor = await provider.get<number>({ key: 'a', namespace: 'session' })

    if (survivor.isFailure()) throw new Error('expected success')
    expect(survivor.value).toEqual({ found: true, value: 2 })
  })
})

describe('consistency modes across two instances', () => {
  /*
   * The scenario that motivated §4 of the spec. Two providers on the same Valkey, so instance B
   * has its own memo and cannot see A's invalidation until something tells it — which is exactly
   * the window strong mode exists to close.
   */
  it('lets a strong read see another instance invalidation immediately', async () => {
    const prefix: string = uniquePrefix({ label: 'strong' })
    const writer = await connect({ prefix })
    const reader = await connect({
      namespaces: { [NAMESPACE]: { consistency: CacheConsistency.STRONG } },
      namespaceVersionLocalTtlInMs: 60_000,
      prefix
    })

    await writer.set({ key: 'a', namespace: NAMESPACE, value: 'first' })

    const warm = await reader.get<string>({ key: 'a', namespace: NAMESPACE })
    if (warm.isFailure()) throw new Error('expected success')
    expect(warm.value).toEqual({ found: true, value: 'first' })

    await writer.invalidateNamespace({ namespace: NAMESPACE })

    const afterInvalidation = await reader.get<string>({ key: 'a', namespace: NAMESPACE })

    if (afterInvalidation.isFailure()) throw new Error('expected success')
    expect(afterInvalidation.value.found).toBe(false)
  })

  /*
   * The other half of the trade. With the broadcast off, the memo TTL is the only thing that ends
   * the window — so an eventual reader is allowed to serve the old value, but never past the
   * ceiling. Both halves of that promise are asserted here.
   */
  it('lets an eventual read serve a stale value, but never past the memo ttl', async () => {
    const prefix: string = uniquePrefix({ label: 'eventual' })
    const writer = await connect({ invalidationBroadcast: false, prefix })
    const reader = await connect({ invalidationBroadcast: false, namespaceVersionLocalTtlInMs: 300, prefix })

    await writer.set({ key: 'a', namespace: NAMESPACE, value: 'first' })

    const warm = await reader.get<string>({ key: 'a', namespace: NAMESPACE })
    if (warm.isFailure()) throw new Error('expected success')
    expect(warm.value.found).toBe(true)

    await writer.invalidateNamespace({ namespace: NAMESPACE })

    const stale = await reader.get<string>({ key: 'a', namespace: NAMESPACE })
    if (stale.isFailure()) throw new Error('expected success')
    expect(stale.value.value).toBe('first')

    await sleep(400)

    const expired = await reader.get<string>({ key: 'a', namespace: NAMESPACE })
    if (expired.isFailure()) throw new Error('expected success')
    expect(expired.value.found).toBe(false)
  })

  /*
   * Best-effort, and that is the point: the broadcast does not replace the TTL, it shortens the
   * typical window from seconds to milliseconds. The memo ttl here is a minute, so a miss inside
   * two seconds can only have come from a message.
   */
  it('shortens the eventual window to milliseconds when the broadcast is on', async () => {
    const prefix: string = uniquePrefix({ label: 'broadcast' })
    const writer = await connect({ invalidationBroadcast: true, namespaceVersionLocalTtlInMs: 60_000, prefix })
    const reader = await connect({ invalidationBroadcast: true, namespaceVersionLocalTtlInMs: 60_000, prefix })

    await writer.set({ key: 'a', namespace: NAMESPACE, value: 'first' })

    const warm = await reader.get<string>({ key: 'a', namespace: NAMESPACE })
    if (warm.isFailure()) throw new Error('expected success')
    expect(warm.value.found).toBe(true)

    await writer.invalidateNamespace({ namespace: NAMESPACE })

    let wasMissed = false
    for (let attempt = 0; !wasMissed && attempt < 40; attempt += 1) {
      await sleep(50)

      const read = await reader.get<string>({ key: 'a', namespace: NAMESPACE })
      if (read.isFailure()) throw new Error('expected success')
      wasMissed = !read.value.found
    }

    expect(wasMissed).toBe(true)
  })
})

describe('cache-aside against a live Valkey', () => {
  it('loads on a miss, then serves the second call from the cache', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'get-or-set' }) })

    let loads = 0
    const loader = (): Promise<ReturnType<typeof success<Error, number>>> => {
      loads += 1

      return Promise.resolve(success(42))
    }

    const first = await provider.getOrSet<number, Error>({ key: 'a', loader, namespace: NAMESPACE })
    const second = await provider.getOrSet<number, Error>({ key: 'a', loader, namespace: NAMESPACE })

    if (first.isFailure() || second.isFailure()) throw new Error('expected success')
    expect(first.value.source).toBe(CacheSource.LOADER)
    expect(second.value.source).toBe(CacheSource.CACHE)
    expect(second.value.value).toBe(42)
    expect(loads).toBe(1)
  })

  /*
   * A loader that answers null is not a failure, it is the negative-cache case: the sentinel is
   * stored so a repeatedly-missing row does not hammer the database once per request.
   */
  it('caches a null answer so a missing row is not looked up twice', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'negative' }) })

    let loads = 0
    const loader = (): Promise<ReturnType<typeof success<Error, number | null>>> => {
      loads += 1

      return Promise.resolve(success(null))
    }

    await provider.getOrSet<number, Error>({ key: 'ghost', loader, namespace: NAMESPACE })
    const second = await provider.getOrSet<number, Error>({ key: 'ghost', loader, namespace: NAMESPACE })

    if (second.isFailure()) throw new Error('expected success')
    expect(second.value.source).toBe(CacheSource.CACHE)
    expect(second.value.value).toBeNull()
    expect(loads).toBe(1)
  })

  it('acquires the fill lock when asked, and says so', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'stampede' }) })

    const loaded = await provider.getOrSet<number, Error>({
      key: 'a',
      loader: () => Promise.resolve(success(1)),
      lock: { enabled: true },
      namespace: NAMESPACE
    })

    if (loaded.isFailure()) throw new Error('expected success')
    expect(loaded.value.lockOutcome).toBe(CacheLockOutcome.ACQUIRED)
  })

  // forceRefresh is a refresh, not a bypass: the loader runs and the cache is rewritten.
  it('rewrites the cache on a forced refresh', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'refresh' }) })

    await provider.getOrSet<number, Error>({
      key: 'a',
      loader: () => Promise.resolve(success(1)),
      namespace: NAMESPACE
    })

    const refreshed = await provider.getOrSet<number, Error>({
      forceRefresh: true,
      key: 'a',
      loader: () => Promise.resolve(success(2)),
      namespace: NAMESPACE
    })

    if (refreshed.isFailure()) throw new Error('expected success')
    expect(refreshed.value.source).toBe(CacheSource.LOADER)

    const read = await provider.get<number>({ key: 'a', namespace: NAMESPACE })
    if (read.isFailure()) throw new Error('expected success')
    expect(read.value.value).toBe(2)
  })
})

describe('counters and scores against a live Valkey', () => {
  /*
   * Fixed window, anchored to the first increment. Renewing on every call would produce a counter
   * that never resets under sustained traffic — a rate limit that latches shut for good.
   */
  it('anchors the counter window to the first increment', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'counter' }) })

    await provider.increment({ key: 'hits', namespace: 'rate', windowInMs: 250 })
    await sleep(120)
    await provider.increment({ key: 'hits', namespace: 'rate', windowInMs: 250 })

    const during = await provider.getCounter({ key: 'hits', namespace: 'rate' })
    if (during.isFailure()) throw new Error('expected success')
    expect(during.value.value).toBe(2)

    await sleep(200)

    const after = await provider.getCounter({ key: 'hits', namespace: 'rate' })
    if (after.isFailure()) throw new Error('expected success')
    expect(after.value.value).toBe(0)
  })

  it('counts up and down', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'counter-updown' }) })

    await provider.increment({ by: 5, key: 'balance', namespace: 'rate' })
    const after = await provider.decrement({ by: 2, key: 'balance', namespace: 'rate' })

    if (after.isFailure()) throw new Error('expected success')
    expect(after.value.value).toBe(3)
  })

  it('ranks members and reports the size of the set alongside the position', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'score' }) })

    await provider.setScore({ key: 'weekly', member: 'ada', namespace: 'board', score: 10 })
    await provider.setScore({ key: 'weekly', member: 'grace', namespace: 'board', score: 30 })
    await provider.setScore({ key: 'weekly', member: 'alan', namespace: 'board', score: 20 })

    const rank = await provider.getRank({ key: 'weekly', member: 'alan', namespace: 'board' })
    const top = await provider.getTopScores({ key: 'weekly', limit: 2, namespace: 'board' })
    const total = await provider.countScores({ key: 'weekly', namespace: 'board' })

    if (rank.isFailure() || top.isFailure() || total.isFailure()) throw new Error('expected success')
    expect(rank.value).toEqual({ rank: 2, total: 3 })
    expect(top.value.entries).toEqual([
      { member: 'grace', score: 30 },
      { member: 'alan', score: 20 }
    ])
    expect(total.value.total).toBe(3)
  })

  it('answers a null rank for a member that is not in the set', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'score-missing' }) })

    await provider.setScore({ key: 'weekly', member: 'ada', namespace: 'board', score: 10 })

    const rank = await provider.getRank({ key: 'weekly', member: 'nobody', namespace: 'board' })

    if (rank.isFailure()) throw new Error('expected success')
    expect(rank.value).toEqual({ rank: null, total: 1 })
  })

  it('increments and removes a member score', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'score-mutate' }) })

    await provider.setScore({ key: 'weekly', member: 'ada', namespace: 'board', score: 10 })
    const bumped = await provider.incrementScore({ by: 5, key: 'weekly', member: 'ada', namespace: 'board' })
    const removed = await provider.removeScore({ key: 'weekly', member: 'ada', namespace: 'board' })
    const missing = await provider.getScore({ key: 'weekly', member: 'ada', namespace: 'board' })

    if (bumped.isFailure() || removed.isFailure() || missing.isFailure()) throw new Error('expected success')
    expect(bumped.value.score).toBe(15)
    expect(removed.value.removed).toBe(true)
    expect(missing.value.score).toBeNull()
  })
})

describe('mutual exclusion against a live Valkey', () => {
  it('runs the task under the lock and releases it afterwards', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'execute-with-lock' }) })

    const executed = await provider.executeWithLock<string, Error>({
      key: 'job-1',
      namespace: 'job',
      task: () => Promise.resolve(success('done')),
      ttlInMs: 5000
    })

    if (executed.isFailure()) throw new Error('expected success')
    expect(executed.value.value).toBe('done')

    const reacquired = await provider.acquire({ key: 'job-1', namespace: 'job', ttlInMs: 1000 })
    expect(reacquired.isSuccess()).toBe(true)
  })

  /*
   * The one operation that deliberately refuses to fail open: the caller asked for exclusion, so
   * not getting it has to be a failure rather than a task that runs anyway.
   */
  it('refuses to run the task when the lock is already held', async () => {
    const provider = await connect({ prefix: uniquePrefix({ label: 'execute-contended' }) })

    const held = await provider.acquire({ key: 'job-2', namespace: 'job', ttlInMs: 30_000 })
    if (held.isFailure()) throw new Error('expected success')

    let didRun = false
    const executed = await provider.executeWithLock<string, Error>({
      key: 'job-2',
      namespace: 'job',
      task: () => {
        didRun = true

        return Promise.resolve(success('done'))
      },
      ttlInMs: 5000
    })

    if (executed.isSuccess()) throw new Error('expected failure')
    expect(didRun).toBe(false)
  })
})
