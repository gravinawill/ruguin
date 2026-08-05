import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { CacheHealthIndicator } from '@ruguin/cache'

import { HealthController } from './health.controller.ts'

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [CacheHealthIndicator]
})
export class HealthModule {}
