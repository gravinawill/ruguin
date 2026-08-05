import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { CacheHealthIndicator } from '@ruguin/cache'

import { DatabaseHealthIndicator } from '../shared/infrastructure/database/prisma/database-health.indicator.ts'

import { HealthController } from './health.controller.ts'

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [CacheHealthIndicator, DatabaseHealthIndicator]
})
export class HealthModule {}
