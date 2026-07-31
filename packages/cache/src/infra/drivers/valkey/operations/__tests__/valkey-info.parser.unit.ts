import { describe, expect, it } from 'vitest'

import { CacheHealthStatus, type HealthCheckProviderDTO } from '../../../../../domain'
import {
  clientsHealthFrom,
  deriveHealthStatus,
  memoryHealthFrom,
  parseValkeyInfo,
  replicationLagFrom,
  serverInfoFrom
} from '../valkey-info.parser'

const MASTER_INFO = [
  '# Server',
  'redis_version:7.2.4',
  'uptime_in_seconds:4211',
  '',
  '# Clients',
  'connected_clients:6',
  'blocked_clients:0',
  '',
  '# Memory',
  'used_memory:1048576',
  'maxmemory:0',
  '',
  '# Stats',
  'evicted_keys:0',
  'rejected_connections:0',
  '',
  '# Replication',
  'role:master',
  'connected_slaves:1',
  'master_repl_offset:5000',
  'slave0:ip=172.18.0.4,port=6379,state=online,offset=4998,lag=0'
].join('\r\n')

const replicaHealth = (
  overrides: Partial<HealthCheckProviderDTO.ReplicaHealth>
): HealthCheckProviderDTO.ReplicaHealth => ({
  host: 'localhost:6380',
  latencyInMs: 1,
  reachable: true,
  replicationLagInBytes: 0,
  ...overrides
})

const memoryHealth = (
  overrides: Partial<HealthCheckProviderDTO.MemoryHealth>
): HealthCheckProviderDTO.MemoryHealth => ({
  evictedKeys: 0,
  maxBytes: null,
  usedBytes: 1024,
  usedPercentage: null,
  ...overrides
})

describe('parseValkeyInfo', () => {
  it('reads fields across every requested section, ignoring headers and CRLF', () => {
    const info = parseValkeyInfo({ raw: MASTER_INFO })

    expect(info.get('redis_version')).toBe('7.2.4')
    expect(info.get('connected_clients')).toBe('6')
    expect(info.get('evicted_keys')).toBe('0')
    expect(info.get('role')).toBe('master')
  })

  // A slaveN line's value is itself full of colons; splitting on the first one keeps it intact.
  it('keeps everything after the first colon as the value', () => {
    const info = parseValkeyInfo({ raw: MASTER_INFO })

    expect(info.get('slave0')).toBe('ip=172.18.0.4,port=6379,state=online,offset=4998,lag=0')
  })
})

describe('memoryHealthFrom', () => {
  /*
   * maxmemory:0 means unlimited, which is the local default. A percentage of an unbounded budget
   * has no meaning, so it must be null — a 0 would read as "plenty of room" and quietly disarm
   * the pressure check on exactly the instances that never trip it.
   */
  it('reports no percentage when maxmemory is unlimited', () => {
    const memory = memoryHealthFrom({ info: parseValkeyInfo({ raw: MASTER_INFO }) })

    expect(memory).toEqual({ evictedKeys: 0, maxBytes: null, usedBytes: 1_048_576, usedPercentage: null })
  })

  it('computes the percentage once maxmemory is set', () => {
    const info = parseValkeyInfo({ raw: 'used_memory:900\nmaxmemory:1000\nevicted_keys:3' })

    expect(memoryHealthFrom({ info })).toEqual({
      evictedKeys: 3,
      maxBytes: 1000,
      usedBytes: 900,
      usedPercentage: 90
    })
  })
})

describe('clientsHealthFrom and serverInfoFrom', () => {
  it('reads the client counters, defaulting a missing rejected_connections to zero', () => {
    const info = parseValkeyInfo({ raw: 'connected_clients:6\nblocked_clients:2' })

    expect(clientsHealthFrom({ info })).toEqual({ blocked: 2, connected: 6, rejectedTotal: 0 })
  })

  it('reads the server identity', () => {
    const info = parseValkeyInfo({ raw: MASTER_INFO })

    expect(serverInfoFrom({ info })).toEqual({ uptimeInSeconds: 4211, version: '7.2.4' })
  })
})

describe('replicationLagFrom', () => {
  it('measures how many bytes the replica still has to replay', () => {
    const master = parseValkeyInfo({ raw: 'master_repl_offset:5000' })
    const replica = parseValkeyInfo({ raw: 'slave_repl_offset:4900' })

    expect(replicationLagFrom({ master, replica })).toBe(100)
  })

  /*
   * Null, never 0. "Unknown lag" and "no lag" have to stay distinct — collapsing them would let a
   * replica with a missing offset field read as perfectly synchronised.
   */
  it('answers null when either side did not report an offset', () => {
    const master = parseValkeyInfo({ raw: 'master_repl_offset:5000' })

    expect(replicationLagFrom({ master, replica: parseValkeyInfo({ raw: 'role:slave' }) })).toBeNull()
  })

  it('never reports negative lag when the replica reads ahead of the sampled master offset', () => {
    const master = parseValkeyInfo({ raw: 'master_repl_offset:4900' })
    const replica = parseValkeyInfo({ raw: 'slave_repl_offset:5000' })

    expect(replicationLagFrom({ master, replica })).toBe(0)
  })
})

describe('deriveHealthStatus', () => {
  it('is healthy when the master answers and nothing is behind', () => {
    expect(
      deriveHealthStatus({
        masterReachable: true,
        memory: memoryHealth({}),
        replicas: [replicaHealth({})],
        replicationLagThresholdInBytes: 1_048_576
      })
    ).toBe(CacheHealthStatus.HEALTHY)
  })

  it('is unhealthy only when the master itself is gone', () => {
    expect(
      deriveHealthStatus({
        masterReachable: false,
        memory: memoryHealth({}),
        replicas: [],
        replicationLagThresholdInBytes: 1_048_576
      })
    ).toBe(CacheHealthStatus.UNHEALTHY)
  })

  /*
   * Degraded, not unhealthy: reads fall back to the master and the application keeps working.
   * Marking this down would pull the instance out of the load balancer and turn a degradation
   * into an outage.
   */
  it('is degraded when a replica is unreachable', () => {
    expect(
      deriveHealthStatus({
        masterReachable: true,
        memory: memoryHealth({}),
        replicas: [replicaHealth({ reachable: false })],
        replicationLagThresholdInBytes: 1_048_576
      })
    ).toBe(CacheHealthStatus.DEGRADED)
  })

  it('is degraded when a replica lags past the threshold', () => {
    expect(
      deriveHealthStatus({
        masterReachable: true,
        memory: memoryHealth({}),
        replicas: [replicaHealth({ replicationLagInBytes: 2_000_000 })],
        replicationLagThresholdInBytes: 1_048_576
      })
    ).toBe(CacheHealthStatus.DEGRADED)
  })

  it('is degraded at 90% of maxmemory, before eviction starts destroying the hit rate', () => {
    expect(
      deriveHealthStatus({
        masterReachable: true,
        memory: memoryHealth({ maxBytes: 1000, usedBytes: 900, usedPercentage: 90 }),
        replicas: [],
        replicationLagThresholdInBytes: 1_048_576
      })
    ).toBe(CacheHealthStatus.DEGRADED)
  })

  it('does not read an unlimited maxmemory as memory pressure', () => {
    expect(
      deriveHealthStatus({
        masterReachable: true,
        memory: memoryHealth({ usedBytes: 9_000_000_000 }),
        replicas: [],
        replicationLagThresholdInBytes: 1_048_576
      })
    ).toBe(CacheHealthStatus.HEALTHY)
  })
})
