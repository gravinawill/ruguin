import { type Either, failure, success } from '@ruguin/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CacheConnectionError, CacheConsistency } from '../../domain/index.ts'
import { NamespaceVersionResolver, type NamespaceVersionSource } from '../namespace-version.resolver.ts'

const sourceReturning = (versions: number[]): { source: NamespaceVersionSource; calls: () => number } => {
  let index = 0

  return {
    source: {
      fetchVersion: (): Promise<Either<CacheConnectionError, { version: number }>> => {
        const version = versions[Math.min(index, versions.length - 1)] ?? 1
        index += 1
        return Promise.resolve(success({ version }))
      }
    },
    calls: () => index
  }
}

const failingSource: NamespaceVersionSource = {
  fetchVersion: () => Promise.resolve(failure(new CacheConnectionError({ operation: 'resolveNamespaceVersion' })))
}

const resolverWith = (namespaces: Record<string, { consistency?: CacheConsistency }>): NamespaceVersionResolver =>
  new NamespaceVersionResolver({
    source: sourceReturning([1]).source,
    defaultConsistency: CacheConsistency.EVENTUAL,
    localTtlInMs: 5000,
    namespaces
  })

describe('NamespaceVersionResolver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('serves the memoised version while it is fresh, without touching the source again', async () => {
    const { source, calls } = sourceReturning([7, 8])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })

    const first = await resolver.resolveNamespaceVersion({ namespace: 'user' })
    const second = await resolver.resolveNamespaceVersion({ namespace: 'user' })

    if (first.isFailure() || second.isFailure()) throw new Error('expected success')
    expect(first.value.version).toBe(7)
    expect(second.value.version).toBe(7)
    expect(calls()).toBe(1)
  })

  it('refetches once the memo expires', async () => {
    const { source, calls } = sourceReturning([7, 8])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })

    await resolver.resolveNamespaceVersion({ namespace: 'user' })
    vi.advanceTimersByTime(5001)
    const second = await resolver.resolveNamespaceVersion({ namespace: 'user' })

    if (second.isFailure()) throw new Error('expected success')
    expect(second.value.version).toBe(8)
    expect(calls()).toBe(2)
  })

  it('never consults the memo in strong mode', async () => {
    const { source, calls } = sourceReturning([7, 8])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })

    await resolver.resolveNamespaceVersion({ namespace: 'user' })
    const second = await resolver.resolveNamespaceVersion({
      namespace: 'user',
      consistency: CacheConsistency.STRONG
    })

    if (second.isFailure()) throw new Error('expected success')
    expect(second.value.version).toBe(8)
    expect(calls()).toBe(2)
  })

  it('takes the strong mode from the namespace config without a per-call flag', async () => {
    const { source, calls } = sourceReturning([7, 8])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: { 'api-key': { consistency: CacheConsistency.STRONG } }
    })

    await resolver.resolveNamespaceVersion({ namespace: 'api-key' })
    await resolver.resolveNamespaceVersion({ namespace: 'api-key' })

    expect(calls()).toBe(2)
  })

  it('lets a per-call value override the namespace config', async () => {
    const { source, calls } = sourceReturning([7, 7])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: { 'api-key': { consistency: CacheConsistency.STRONG } }
    })

    await resolver.resolveNamespaceVersion({ namespace: 'api-key' })
    await resolver.resolveNamespaceVersion({ namespace: 'api-key', consistency: CacheConsistency.EVENTUAL })

    expect(calls()).toBe(1)
  })

  it('bypasses the memo entirely when the local ttl is zero', async () => {
    const { source, calls } = sourceReturning([7, 8])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 0,
      namespaces: {}
    })

    await resolver.resolveNamespaceVersion({ namespace: 'user' })
    await resolver.resolveNamespaceVersion({ namespace: 'user' })

    expect(calls()).toBe(2)
  })

  it('falls back to the last known version when the source fails in eventual mode', async () => {
    const { source } = sourceReturning([7])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })

    await resolver.resolveNamespaceVersion({ namespace: 'user' })
    vi.advanceTimersByTime(5001)

    const degraded = new NamespaceVersionResolver({
      source: failingSource,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })
    degraded.applyBroadcast({ namespace: 'user', version: 7 })
    vi.advanceTimersByTime(5001)

    const result = await degraded.resolveNamespaceVersion({ namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.version).toBe(7)
  })

  it('falls back to version 1 when the source fails and nothing was ever known', async () => {
    const resolver = new NamespaceVersionResolver({
      source: failingSource,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })

    const result = await resolver.resolveNamespaceVersion({ namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.version).toBe(1)
  })

  it('propagates the failure in strong mode rather than serving a guess', async () => {
    const resolver = new NamespaceVersionResolver({
      source: failingSource,
      defaultConsistency: CacheConsistency.STRONG,
      localTtlInMs: 5000,
      namespaces: {}
    })

    const result = await resolver.resolveNamespaceVersion({ namespace: 'user' })

    expect(result.isFailure()).toBe(true)
  })

  it('applies a broadcast that moves the version forward', async () => {
    const { source, calls } = sourceReturning([7])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })

    await resolver.resolveNamespaceVersion({ namespace: 'user' })
    resolver.applyBroadcast({ namespace: 'user', version: 9 })
    const result = await resolver.resolveNamespaceVersion({ namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.version).toBe(9)
    expect(calls()).toBe(1)
  })

  it('ignores a broadcast that would move the version backwards', async () => {
    const { source } = sourceReturning([7])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })

    await resolver.resolveNamespaceVersion({ namespace: 'user' })
    resolver.applyBroadcast({ namespace: 'user', version: 3 })
    const result = await resolver.resolveNamespaceVersion({ namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.version).toBe(7)
  })

  it('drops the whole memo on clearMemo, not just one namespace', async () => {
    const { source, calls } = sourceReturning([7, 7, 8, 8])
    const resolver = new NamespaceVersionResolver({
      source,
      defaultConsistency: CacheConsistency.EVENTUAL,
      localTtlInMs: 5000,
      namespaces: {}
    })

    await resolver.resolveNamespaceVersion({ namespace: 'user' })
    await resolver.resolveNamespaceVersion({ namespace: 'order' })
    resolver.clearMemo()
    await resolver.resolveNamespaceVersion({ namespace: 'user' })
    await resolver.resolveNamespaceVersion({ namespace: 'order' })

    expect(calls()).toBe(4)
  })
})

/*
 * Exposed because the cascade decides more than the version lookup: a driver with read replicas
 * has to route the *command* to the same node the version came from, and a strong read served
 * off a replica whose INCR has not landed is the stale answer the mode exists to rule out.
 */
describe('effectiveConsistency', () => {
  it('lets the call override everything', () => {
    const resolver = resolverWith({ user: { consistency: CacheConsistency.EVENTUAL } })

    expect(resolver.effectiveConsistency({ namespace: 'user', consistency: CacheConsistency.STRONG })).toBe(
      CacheConsistency.STRONG
    )
  })

  it('falls back to the namespace declaration, which is the preferred place to state it', () => {
    const resolver = resolverWith({ 'api-key': { consistency: CacheConsistency.STRONG } })

    expect(resolver.effectiveConsistency({ namespace: 'api-key' })).toBe(CacheConsistency.STRONG)
  })

  it('falls back to the global default for an undeclared namespace', () => {
    const resolver = resolverWith({ 'api-key': { consistency: CacheConsistency.STRONG } })

    expect(resolver.effectiveConsistency({ namespace: 'session' })).toBe(CacheConsistency.EVENTUAL)
  })
})
