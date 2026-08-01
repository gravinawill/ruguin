import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CacheDriver, CacheHealthStatus, type ICacheProvider } from '../../../../../domain/index.ts'
import { createValkeyCache, REPLICA_URL, uniquePrefix } from '../../__tests__/valkey-test-context.ts'

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
  const provider = createValkeyCache({
    prefix: uniquePrefix({ label: 'health' }),
    replicaUrls: [REPLICA_URL]
  }).provider

  const connected = await provider.connect()
  if (connected.isFailure()) throw new Error(connected.value.message)

  context.provider = provider
})

afterAll(async () => {
  await cache().disconnect()
})

describe('health check against a live Valkey', () => {
  it('reports the master as reachable and in the master role', async () => {
    const health = await cache().healthCheck()

    if (health.isFailure()) throw new Error('expected success')
    expect(health.value.driver).toBe(CacheDriver.VALKEY)
    expect(health.value.master.reachable).toBe(true)
    expect(health.value.master.role).toBe('master')
    expect(health.value.master.latencyInMs).toBeGreaterThanOrEqual(0)
  })

  it('reads the server identity out of INFO', async () => {
    const health = await cache().healthCheck()

    if (health.isFailure()) throw new Error('expected success')
    expect(health.value.server.version).toMatch(/^\d+\.\d+/u)
    expect(health.value.server.uptimeInSeconds).toBeGreaterThan(0)
  })

  /*
   * The local instance runs with maxmemory:0, so the percentage has to be null. A 0 here would
   * read as "plenty of room" and disarm the pressure check on every instance that never sets a
   * limit — which is all of them, locally.
   */
  it('reports no memory percentage while maxmemory is unlimited', async () => {
    const health = await cache().healthCheck()

    if (health.isFailure()) throw new Error('expected success')
    expect(health.value.memory.usedBytes).toBeGreaterThan(0)
    expect(health.value.memory.maxBytes).toBeNull()
    expect(health.value.memory.usedPercentage).toBeNull()
    expect(health.value.memory.evictedKeys).toBeGreaterThanOrEqual(0)
  })

  it('reads the client counters, including the ones that only matter before an incident', async () => {
    const health = await cache().healthCheck()

    if (health.isFailure()) throw new Error('expected success')
    expect(health.value.clients.connected).toBeGreaterThan(0)
    expect(health.value.clients.blocked).toBeGreaterThanOrEqual(0)
    expect(health.value.clients.rejectedTotal).toBeGreaterThanOrEqual(0)
  })

  it('probes the replica and measures how far behind it is', async () => {
    const health = await cache().healthCheck()

    if (health.isFailure()) throw new Error('expected success')
    expect(health.value.replicas).toHaveLength(1)

    const replica = health.value.replicas[0]
    expect(replica?.reachable).toBe(true)
    expect(replica?.replicationLagInBytes).not.toBeNull()
  })

  it('reports healthy when master and replica are both in step', async () => {
    const health = await cache().healthCheck()

    if (health.isFailure()) throw new Error('expected success')
    expect(health.value.status).toBe(CacheHealthStatus.HEALTHY)
  })

  it('skips the replicas when the caller asks it to', async () => {
    const health = await cache().healthCheck({ includeReplicas: false })

    if (health.isFailure()) throw new Error('expected success')
    expect(health.value.replicas).toEqual([])
  })

  /*
   * The only Either failure this contract admits. Everything else — an unreachable master
   * included — is a *reported* status, because "the cache is down" is the answer the caller asked
   * for, not a failure to answer.
   */
  it('fails only when called before connect(), which is a programming error', async () => {
    const fresh = createValkeyCache({ prefix: uniquePrefix({ label: 'health-cold' }) }).provider

    const health = await fresh.healthCheck()

    if (health.isSuccess()) throw new Error('expected failure')
    expect(health.value.name).toBe('CacheNotInitializedError')
  })
})
