import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type ICacheProvider } from '../../../../../domain'
import { createValkeyCache, uniquePrefix } from '../../__tests__/valkey-test-context'

const NAMESPACE = 'job'

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
  const provider = createValkeyCache({ prefix: uniquePrefix({ label: 'lock' }) }).provider

  const connected = await provider.connect()
  if (connected.isFailure()) throw new Error(connected.value.message)

  context.provider = provider
})

afterAll(async () => {
  await cache().disconnect()
})

describe('lock operations against a live Valkey', () => {
  // SET NX PX: the semantics the whole lock rests on, and the one thing a mock would just assert.
  it('lets exactly one caller hold a key', async () => {
    const first = await cache().acquire({ key: 'exclusive', namespace: NAMESPACE, ttlInMs: 5000 })
    const second = await cache().acquire({ key: 'exclusive', namespace: NAMESPACE, ttlInMs: 5000 })

    if (first.isFailure()) throw new Error('expected the first acquire to succeed')
    if (second.isSuccess()) throw new Error('expected the second acquire to fail')
    expect(second.value.name).toBe('LockNotAcquiredError')

    await cache().release({ key: 'exclusive', namespace: NAMESPACE, token: first.value.token })
  })

  it('hands out a different token per acquisition', async () => {
    const first = await cache().acquire({ key: 'token-a', namespace: NAMESPACE, ttlInMs: 5000 })
    const second = await cache().acquire({ key: 'token-b', namespace: NAMESPACE, ttlInMs: 5000 })

    if (first.isFailure() || second.isFailure()) throw new Error('expected success')
    expect(first.value.token).not.toBe(second.value.token)
  })

  /*
   * The compare-and-swap, proved by the server. A blind DEL here would let a process whose lock
   * already expired delete the lock a *different* process took after it — two owners at once, and
   * no error anywhere to say so.
   */
  it('refuses to release a lock held by someone else, and leaves it held', async () => {
    const held = await cache().acquire({ key: 'guarded', namespace: NAMESPACE, ttlInMs: 5000 })
    if (held.isFailure()) throw new Error('expected success')

    const stolen = await cache().release({ key: 'guarded', namespace: NAMESPACE, token: 'not-the-owner' })

    if (stolen.isSuccess()) throw new Error('expected failure')
    expect(stolen.value.name).toBe('LockNotOwnedError')

    const contender = await cache().acquire({ key: 'guarded', namespace: NAMESPACE, ttlInMs: 5000 })
    expect(contender.isFailure()).toBe(true)

    await cache().release({ key: 'guarded', namespace: NAMESPACE, token: held.value.token })
  })

  it('frees the key once the owner releases it', async () => {
    const held = await cache().acquire({ key: 'handover', namespace: NAMESPACE, ttlInMs: 5000 })
    if (held.isFailure()) throw new Error('expected success')

    const released = await cache().release({ key: 'handover', namespace: NAMESPACE, token: held.value.token })
    if (released.isFailure()) throw new Error('expected success')
    expect(released.value.released).toBe(true)

    const next = await cache().acquire({ key: 'handover', namespace: NAMESPACE, ttlInMs: 5000 })
    expect(next.isSuccess()).toBe(true)
  })

  it('refuses to extend a lock held by someone else', async () => {
    const held = await cache().acquire({ key: 'extendable', namespace: NAMESPACE, ttlInMs: 5000 })
    if (held.isFailure()) throw new Error('expected success')

    const stolen = await cache().extend({
      key: 'extendable',
      namespace: NAMESPACE,
      token: 'not-the-owner',
      ttlInMs: 60_000
    })

    if (stolen.isSuccess()) throw new Error('expected failure')
    expect(stolen.value.name).toBe('LockNotOwnedError')
  })

  it('extends a lock for its owner', async () => {
    const held = await cache().acquire({ key: 'renewed', namespace: NAMESPACE, ttlInMs: 1000 })
    if (held.isFailure()) throw new Error('expected success')

    const extended = await cache().extend({
      key: 'renewed',
      namespace: NAMESPACE,
      token: held.value.token,
      ttlInMs: 60_000
    })

    if (extended.isFailure()) throw new Error('expected success')
    expect(extended.value.expiresAt.getTime()).toBeGreaterThan(held.value.expiresAt.getTime())
  })

  /*
   * The budget is spent against a real clock, not converted into an attempt count: this waits
   * out a lock that expires on its own, which is precisely the case a "give up after N tries"
   * driver would abandon early or overshoot.
   */
  it('waits within its budget for a lock that expires on its own', async () => {
    const doomed = await cache().acquire({ key: 'queued', namespace: NAMESPACE, ttlInMs: 200 })
    if (doomed.isFailure()) throw new Error('expected success')

    const queued = await cache().acquire({
      key: 'queued',
      namespace: NAMESPACE,
      ttlInMs: 5000,
      wait: { pollIntervalInMs: 25, timeoutInMs: 2000 }
    })

    expect(queued.isSuccess()).toBe(true)
  })

  it('gives up when the budget runs out, and says how many attempts it made', async () => {
    const held = await cache().acquire({ key: 'contended', namespace: NAMESPACE, ttlInMs: 30_000 })
    if (held.isFailure()) throw new Error('expected success')

    const queued = await cache().acquire({
      key: 'contended',
      namespace: NAMESPACE,
      ttlInMs: 5000,
      wait: { pollIntervalInMs: 25, timeoutInMs: 150 }
    })

    if (queued.isSuccess()) throw new Error('expected failure')
    expect(queued.value.message).toMatch(/attempt/u)
  })

  // Locks carry no version segment, so an invalidateNamespace mid-hold cannot orphan the key.
  it('keeps a held lock reachable across an invalidateNamespace', async () => {
    const held = await cache().acquire({ key: 'survivor', namespace: NAMESPACE, ttlInMs: 30_000 })
    if (held.isFailure()) throw new Error('expected success')

    await cache().invalidateNamespace({ namespace: NAMESPACE })

    const released = await cache().release({ key: 'survivor', namespace: NAMESPACE, token: held.value.token })

    if (released.isFailure()) throw new Error('expected success')
    expect(released.value.released).toBe(true)
  })
})
