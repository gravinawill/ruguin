import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'

import { HealthController } from './health.controller'

@Module({
  imports: [TerminusModule],
  controllers: [HealthController]
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- this is a module
export class HealthModule {}
