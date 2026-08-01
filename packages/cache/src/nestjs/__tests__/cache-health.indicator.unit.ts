import { failure, success } from '@ruguin/utils'
import { describe, expect, it } from 'vitest'

import {
  CacheDriver,
  CacheHealthStatus,
  CacheNotInitializedError,
  type HealthCheckProviderDTO,
  type IHealthCheckProvider
} from '../../domain/index.ts'
import { CacheHealthIndicator } from '../cache-health.indicator.ts'

const payload = (
  overrides: Partial<HealthCheckProviderDTO.OutputSuccess> = {}
): HealthCheckProviderDTO.OutputSuccess => ({
  checkedAt: new Date('2026-07-31T00:00:00.000Z'),
  clients: { blocked: 0, connected: 3, rejectedTotal: 0 },
  driver: CacheDriver.VALKEY,
  master: { latencyInMs: 2, reachable: true, role: 'master' },
  memory: { evictedKeys: 0, maxBytes: 1000, usedBytes: 100, usedPercentage: 10 },
  replicas: [],
  server: { uptimeInSeconds: 60, version: '7.2.4' },
  status: CacheHealthStatus.HEALTHY,
  ...overrides
})

const indicatorFor = (result: Awaited<HealthCheckProviderDTO.Output>): CacheHealthIndicator => {
  const cache: IHealthCheckProvider = { healthCheck: () => Promise.resolve(result) }

  return new CacheHealthIndicator(cache)
}

describe('CacheHealthIndicator', () => {
  it('reports up when the cache is healthy', async () => {
    const checked = await indicatorFor(success(payload())).isHealthy('cache')

    expect(checked).toMatchObject({ cache: { cacheStatus: CacheHealthStatus.HEALTHY, status: 'up' } })
  })

  /*
   * The rule the whole indicator exists for. A replica that went away means reads fall back to the
   * master; taking the instance out of the load balancer for that turns a degradation into an
   * outage. The detail fields still travel, so an alert can tell degraded from healthy.
   */
  it('reports up when the cache is degraded, with the reason in the payload', async () => {
    const checked = await indicatorFor(
      success(
        payload({
          replicas: [{ host: 'replica:6379', latencyInMs: 3, reachable: false, replicationLagInBytes: null }],
          status: CacheHealthStatus.DEGRADED
        })
      )
    ).isHealthy('cache')

    expect(checked).toMatchObject({
      cache: {
        cacheStatus: CacheHealthStatus.DEGRADED,
        replicas: [{ host: 'replica:6379', reachable: false }],
        status: 'up'
      }
    })
  })

  it('reports down only when the master itself is unreachable', async () => {
    const checked = await indicatorFor(
      success(
        payload({
          master: { error: 'ECONNREFUSED', latencyInMs: 0, reachable: false, role: 'unknown' },
          status: CacheHealthStatus.UNHEALTHY
        })
      )
    ).isHealthy('cache')

    expect(checked).toMatchObject({ cache: { masterReachable: false, status: 'down' } })
  })

  /* A check that never ran is not a healthy cache — the only Either failure the contract admits. */
  it('reports down when the health check itself could not run', async () => {
    const checked = await indicatorFor(failure(new CacheNotInitializedError({ operation: 'healthCheck' }))).isHealthy(
      'cache'
    )

    expect(checked).toMatchObject({ cache: { status: 'down' } })
    expect(checked.cache).toHaveProperty('error')
  })

  it('carries the pressure signals an alert needs', async () => {
    const checked = await indicatorFor(
      success(
        payload({
          clients: { blocked: 0, connected: 90, rejectedTotal: 12 },
          memory: { evictedKeys: 5000, maxBytes: 1000, usedBytes: 950, usedPercentage: 95 },
          status: CacheHealthStatus.DEGRADED
        })
      )
    ).isHealthy('cache')

    expect(checked).toMatchObject({
      cache: { clientsRejectedTotal: 12, evictedKeys: 5000, memoryUsedPercentage: 95 }
    })
  })
})
