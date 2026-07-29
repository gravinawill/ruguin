import { Module } from '@nestjs/common'

import { HealthModule } from './health/health.module.js'

@Module({
  imports: [HealthModule],
  controllers: [],
  providers: []
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- this is a module
export class AppModule {}
