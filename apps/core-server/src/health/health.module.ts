import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { CacheHealthIndicator } from '@ruguin/cache'

import { DatabaseHealthIndicator } from '../shared/database/database-health.indicator'

import { HealthController } from './health.controller'

/*
 * CacheHealthIndicator is declared here rather than by CacheModule: registering it there would push
 * @nestjs/terminus onto every consumer of the cache, including the ones with no HTTP surface at all.
 * The cache token it injects comes from the globally registered CacheModule. DatabaseHealthIndicator
 * follows the same rule for the same reason.
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [CacheHealthIndicator, DatabaseHealthIndicator]
})
export class HealthModule {}
