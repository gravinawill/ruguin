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
    /*
     * HealthController already declares its own full path (`@Controller({ path: 'health' })`), so
     * registering it here too would double-prefix it to /health/health — only modules without an
     * explicit controller path belong in this list.
     */
    NestJsRouterModule.register([
      {
        path: '/emails',
        module: RoutesEmailsModule
      }
    ])
  ]
})
export class RouterModule {}
