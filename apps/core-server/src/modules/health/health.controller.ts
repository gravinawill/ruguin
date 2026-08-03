import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common'
import { HealthCheck, type HealthCheckResult, HealthCheckService } from '@nestjs/terminus'
import { CacheHealthIndicator } from '@ruguin/cache'

import { DatabaseHealthIndicator } from '../../shared/infrastructure/database/prisma/database-health.indicator'

@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly cacheHealth: CacheHealthIndicator,
    private readonly databaseHealth: DatabaseHealthIndicator
  ) {}

  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.cacheHealth.isHealthy('cache'),
      () => this.databaseHealth.isHealthy('database')
    ])
  }
}
