import { Module } from '@nestjs/common'
import { RouterModule as NestJsRouterModule } from '@nestjs/core'

import { RoutesEmailsModule } from '../modules/emails/presentation/routes/routes.user.module'
import { HealthModule } from '../modules/health/health.module'

@Module({
  providers: [],
  exports: [],
  controllers: [],
  imports: [
    HealthModule,
    RoutesEmailsModule,
    NestJsRouterModule.register([
      {
        path: '/health',
        module: HealthModule
      },
      {
        path: '/emails',
        module: RoutesEmailsModule
      }
    ])
  ]
})
export class RouterModule {}
