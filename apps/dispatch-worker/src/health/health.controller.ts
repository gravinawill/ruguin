import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common'
import { HealthCheck, type HealthCheckResult, HealthCheckService } from '@nestjs/terminus'
import { CacheHealthIndicator } from '@ruguin/cache'

@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly cacheHealth: CacheHealthIndicator
  ) {}

  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([() => this.cacheHealth.isHealthy('cache')])
  }
}
