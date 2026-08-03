import { Inject, Injectable } from '@nestjs/common'
import { type HealthIndicatorResult } from '@nestjs/terminus'

import { CacheHealthStatus, type HealthCheckProviderDTO, type IHealthCheckProvider } from '../domain/index.ts'

import { HEALTH_CHECK_PROVIDER } from './cache.tokens.ts'

/*
 * Flattened deliberately: Terminus renders whatever object it is handed straight into the /health
 * payload, and a nested master/replicas/memory tree there is a body an alert rule has to walk. The
 * fields kept are the ones spec §5.6 argues catch trouble before it becomes an incident.
 *
 * `cacheStatus`, not `status`: Terminus owns the `status` key of every indicator entry.
 */
const toDetails = (payload: HealthCheckProviderDTO.OutputSuccess) => ({
  driver: payload.driver,
  cacheStatus: payload.status,
  serverVersion: payload.server.version,
  evictedKeys: payload.memory.evictedKeys,
  masterReachable: payload.master.reachable,
  clientsConnected: payload.clients.connected,
  masterLatencyInMs: payload.master.latencyInMs,
  clientsRejectedTotal: payload.clients.rejectedTotal,
  memoryUsedPercentage: payload.memory.usedPercentage,
  replicas: payload.replicas.map((replica) => ({
    host: replica.host,
    reachable: replica.reachable,
    replicationLagInBytes: replica.replicationLagInBytes
  }))
})

/*
 * @nestjs/terminus is imported for types only, and nothing from it is injected. That is not
 * fastidiousness: pnpm gives this package its own copy of terminus, so a HealthIndicatorService
 * asked for here would be a different class from the one TerminusModule provides in the app, and
 * Nest would refuse to resolve it. Terminus reads `status` off whatever object the indicator
 * function returns, and that object is three lines to build.
 *
 * The app declares this provider in the module that imports TerminusModule; CacheModule does not
 * register it, so a consumer with no HTTP surface never pulls terminus in at all.
 */
@Injectable()
export class CacheHealthIndicator {
  private readonly cache: IHealthCheckProvider

  constructor(@Inject(HEALTH_CHECK_PROVIDER) cache: IHealthCheckProvider) {
    this.cache = cache
  }

  /*
   * `degraded` counts as up. Pulling the instance out of the load balancer because one replica went
   * away would turn a degradation into an outage — reads simply fall back to the master and the
   * application keeps serving. Only `unhealthy`, meaning the master itself is unreachable, marks
   * down. The collected details ride along in both cases, which is what lets an alert tell the two
   * scenarios apart.
   */
  public async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const checked = await this.cache.healthCheck()

    if (checked.isFailure()) return { [key]: { error: checked.value.message, status: 'down' } }

    const isUp: boolean = checked.value.status !== CacheHealthStatus.UNHEALTHY

    return { [key]: { ...toDetails(checked.value), status: isUp ? 'up' : 'down' } }
  }
}
