import { Module } from '@nestjs/common'
import { RouterModule as NestJsRouterModule } from '@nestjs/core'

import { EmailsModule } from '../modules/emails/emails.module'
import { RoutesEmailsModule } from '../modules/emails/presentation/routes/routes.user.module'
import { HealthModule } from '../modules/health/health.module'
import { RoutesSenderIdentitiesModule } from '../modules/sender-identities/presentation/routes/routes.user.module'
import { SenderIdentitiesModule } from '../modules/sender-identities/sender-identities.module'

@Module({
  providers: [],
  exports: [],
  controllers: [],
  imports: [
    HealthModule,
    RoutesEmailsModule,
    RoutesSenderIdentitiesModule,
    /*
     * HealthController already declares its own full path (`@Controller({ path: 'health' })`), so
     * registering it here too would double-prefix it to /health/health — only modules without an
     * explicit controller path belong in this list.
     *
     * RouterModule.register() builds its own route tree, separate from ordinary Nest module
     * imports/DI. A `path` prefix only reaches the controllers declared directly on the target
     * module, and only propagates further through this tree's own `children` entries — NOT by
     * following the target module's `@Module({ imports: [...] })` metadata. Each Routes* wrapper
     * merely imports its real module for DI composition, so the real controller (declared inside
     * that module, not the wrapper) needs its own `children` entry here to inherit the prefix.
     */
    NestJsRouterModule.register([
      {
        path: '/emails',
        module: RoutesEmailsModule,
        children: [{ path: '', module: EmailsModule }]
      },
      {
        path: '/sender-identities',
        module: RoutesSenderIdentitiesModule,
        children: [{ path: '', module: SenderIdentitiesModule }]
      }
    ])
  ]
})
export class RouterModule {}
