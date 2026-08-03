import { Module } from '@nestjs/common'

import { EmailModule } from './email/email.module.ts'
import { HealthModule } from './health/health.module.ts'

@Module({
  imports: [EmailModule, HealthModule],
  controllers: [],
  providers: []
})
export class AppModule {}
