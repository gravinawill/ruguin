import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type ICacheProvider } from '../../../../../domain'
import { createValkeyCache, sleep, uniquePrefix } from '../../__tests__/valkey-test-context'

const NAMESPACE = 'user'

/*
 * A holder rather than a bare `let`: the suite needs one connection shared by every case, and
 * reassigning a module-level binding from inside beforeAll is exactly what this repo's lint
 * refuses. `cache()` also fails loudly if a case ever runs before the hook.
 */
const context: { provider: ICacheProvider | null } = { provider: null }

const cache = (): ICacheProvider => {
  if (context.provider === null) throw new Error('the provider was never connected')

  return context.provider
}

beforeAll(async () => {
  const provider = createValkeyCache({ prefix: uniquePrefix({ label: 'key-value' }) }).provider

  const connected = await provider.connect()
  if (connected.isFailure()) throw new Error(connected.value.message)

  context.provider = provider
})

afterAll(async () => {
  await cache().disconnect()
})

describe('key-value operations against a live Valkey', () => {
  it('round-trips a value', async () => {
    await cache().set({ key: 'round-trip', namespace: NAMESPACE, value: { id: '1', name: 'ada' } })

    const read = await cache().get<{ id: string; name: string }>({ key: 'round-trip', namespace: NAMESPACE })

    if (read.isFailure()) throw new Error('expected success')
    expect(read.value).toEqual({ found: true, value: { id: '1', name: 'ada' } })
  })

  it('misses on a key that was never written', async () => {
    const read = await cache().get({ key: 'never-written', namespace: NAMESPACE })

    if (read.isFailure()) throw new Error('expected success')
    expect(read.value).toEqual({ found: false, value: null })
  })

  /*
   * The one thing a mock cannot prove. PX is the only reason an unbounded cache does not grow
   * until eviction starts, and an off-by-a-thousand on the unit would only show up in production
   * as memory that never comes back.
   */
  it('actually expires a key when its TTL elapses', async () => {
    await cache().set({ key: 'short-lived', namespace: NAMESPACE, ttlInMs: 150, value: 'gone soon' })

    const immediately = await cache().get<string>({ key: 'short-lived', namespace: NAMESPACE })
    if (immediately.isFailure()) throw new Error('expected success')
    expect(immediately.value.found).toBe(true)

    await sleep(250)

    const later = await cache().get<string>({ key: 'short-lived', namespace: NAMESPACE })
    if (later.isFailure()) throw new Error('expected success')
    expect(later.value.found).toBe(false)
  })

  it('reports the expiry it asked the server for', async () => {
    const before: number = Date.now()

    const stored = await cache().set({ key: 'expires-at', namespace: NAMESPACE, ttlInMs: 30_000, value: 1 })

    if (stored.isFailure()) throw new Error('expected success')
    expect(stored.value.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 30_000)
  })

  // SET NX: the second caller is told the key was already there, which is idempotency, not failure.
  it('stores only the first setIfNotExists for a key', async () => {
    const first = await cache().setIfNotExists({ key: 'once', namespace: NAMESPACE, ttlInMs: 30_000, value: 'a' })
    const second = await cache().setIfNotExists({ key: 'once', namespace: NAMESPACE, ttlInMs: 30_000, value: 'b' })

    if (first.isFailure() || second.isFailure()) throw new Error('expected success')
    expect(first.value.stored).toBe(true)
    expect(second.value.stored).toBe(false)

    const read = await cache().get<string>({ key: 'once', namespace: NAMESPACE })
    if (read.isFailure()) throw new Error('expected success')
    expect(read.value.value).toBe('a')
  })

  it('reports whether a delete removed anything', async () => {
    await cache().set({ key: 'doomed', namespace: NAMESPACE, value: 1 })

    const first = await cache().delete({ key: 'doomed', namespace: NAMESPACE })
    const second = await cache().delete({ key: 'doomed', namespace: NAMESPACE })

    if (first.isFailure() || second.isFailure()) throw new Error('expected success')
    expect(first.value.existed).toBe(true)
    expect(second.value.existed).toBe(false)
  })

  /*
   * After a deploy changes a type's shape the cache still holds the old JSON, and the cast to T
   * lies. `validate` turns that into a miss so the loader refills it, instead of a bug that only
   * reproduces on instances warm from before the deploy.
   */
  it('treats a value that fails validation as a miss, not as an error', async () => {
    await cache().set({ key: 'stale-shape', namespace: NAMESPACE, value: { legacy: true } })

    const read = await cache().get<{ id: string }>({
      key: 'stale-shape',
      namespace: NAMESPACE,
      validate: (value) => typeof value === 'object' && value !== null && 'id' in value
    })

    if (read.isFailure()) throw new Error('expected success')
    expect(read.value).toEqual({ found: false, value: null })
  })

  // null is a value, not an absence: this is what makes negative caching possible at all.
  it('distinguishes a stored null from a missing key', async () => {
    await cache().set({ key: 'explicit-null', namespace: NAMESPACE, value: null })

    const read = await cache().get<string>({ key: 'explicit-null', namespace: NAMESPACE })

    if (read.isFailure()) throw new Error('expected success')
    expect(read.value).toEqual({ found: true, value: null })
  })
})
