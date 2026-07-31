import { Redis } from 'iovalkey'
import { afterAll, describe, expect, it } from 'vitest'

import { MASTER_URL, REPLICA_URL } from '../../__tests__/valkey-test-context'
import { ValkeyConnectionManager } from '../valkey-connection.manager'

const managers: ValkeyConnectionManager[] = []

const connected = async (input: {
  replicaUrls?: readonly string[]
  withSubscriber?: boolean
}): Promise<ValkeyConnectionManager> => {
  const manager = new ValkeyConnectionManager({
    masterUrl: MASTER_URL,
    replicaUrls: input.replicaUrls ?? [],
    withSubscriber: input.withSubscriber ?? false
  })
  managers.push(manager)

  const result = await manager.connect()
  if (result.isFailure()) throw new Error(result.value.message)

  return manager
}

describe('ValkeyConnectionManager', () => {
  afterAll(async () => {
    await Promise.all(managers.map(async (manager) => manager.disconnect()))
  })

  it('refuses every client until connect() has run', () => {
    const manager = new ValkeyConnectionManager({ masterUrl: MASTER_URL, withSubscriber: false })

    const master = manager.master()

    if (master.isSuccess()) throw new Error('expected failure')
    expect(master.value.name).toBe('CacheNotInitializedError')
  })

  it('connects to the master and answers a PING', async () => {
    const manager = await connected({})

    const master = manager.master()
    if (master.isFailure()) throw new Error('expected success')
    await expect(master.value.ping()).resolves.toBe('PONG')
  })

  it('reports a refused connection as a connection error rather than throwing', async () => {
    const manager = new ValkeyConnectionManager({
      masterUrl: 'redis://127.0.0.1:6399',
      options: { connectTimeout: 300, retryStrategy: () => null },
      withSubscriber: false
    })

    const result = await manager.connect()

    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value.name).toBe('CacheConnectionError')
  })

  it('routes reads to the master when no replica is configured', async () => {
    const manager = await connected({})

    const reader = manager.reader()
    const master = manager.master()

    if (reader.isFailure() || master.isFailure()) throw new Error('expected success')
    expect(reader.value).toBe(master.value)
  })

  it('opens a third connection for the subscriber, because subscribe mode refuses commands', async () => {
    const manager = await connected({ withSubscriber: true })

    const subscriber = manager.subscriber()
    const master = manager.master()

    if (subscriber.isFailure() || master.isFailure()) throw new Error('expected success')
    expect(subscriber.value).not.toBe(master.value)
  })

  it('routes reads to the replica once one is configured', async () => {
    const manager = await connected({ replicaUrls: [REPLICA_URL] })

    const reader = manager.reader()
    const master = manager.master()

    if (reader.isFailure() || master.isFailure()) throw new Error('expected success')
    expect(reader.value).not.toBe(master.value)
    expect(manager.replicas()).toHaveLength(1)
  })

  /*
   * The routing table's whole point, proved by the server rather than by inspection: a write that
   * reached the replica would come back as READONLY. Every write path asks for master() by name,
   * so this error is the thing that must never appear in the other integration files.
   */
  it('proves the replica would refuse a write, which is why writes never go there', async () => {
    const replica = new Redis(REPLICA_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })

    try {
      await replica.connect()
      await expect(replica.set('ruguin-test:readonly-probe', '1')).rejects.toThrow(/READONLY/u)
    } finally {
      await replica.quit()
    }
  })
})
