import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common'
import { HealthCheck, type HealthCheckResult, HealthCheckService } from '@nestjs/terminus'

@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly health: HealthCheckService) {}

  /*
   * The return type is spelled out rather than inferred. @ruguin/cache carries @nestjs/terminus as
   * an optional peer plus a devDependency of its own, so pnpm gives it a second copy of the types
   * and the inferred signature would name a path under packages/cache/node_modules — TS2742, and a
   * declaration nobody outside this workspace layout could consume.
   */
  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([])
  }
}
