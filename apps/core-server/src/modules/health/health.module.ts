import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { CacheHealthIndicator } from '@ruguin/cache'

import { DatabaseHealthIndicator } from '../../shared/infrastructure/database/prisma/database-health.indicator'

import { HealthController } from './health.controller'

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [CacheHealthIndicator, DatabaseHealthIndicator]
})
export class HealthModule {}
