import { Module } from '@nestjs/common'
import { RouterModule as NestJsRouterModule } from '@nestjs/core'

import { EmailsModule } from '../modules/emails/emails.module'
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
     *
     * RouterModule.register() builds its own route tree, separate from ordinary Nest module
     * imports/DI. A `path` prefix only reaches the controllers declared directly on the target
     * module, and only propagates further through this tree's own `children` entries — NOT by
     * following the target module's `@Module({ imports: [...] })` metadata. RoutesEmailsModule
     * merely imports EmailsModule for DI composition, so EmailController (declared inside
     * EmailsModule) needs its own `children` entry here to inherit the /emails prefix.
     */
    NestJsRouterModule.register([
      {
        path: '/emails',
        module: RoutesEmailsModule,
        children: [{ path: '', module: EmailsModule }]
      }
    ])
  ]
})
export class RouterModule {}
