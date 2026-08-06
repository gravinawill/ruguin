import { Module } from '@nestjs/common'

import { SenderIdentitiesModule } from '../../sender-identities.module'

@Module({
  controllers: [],
  providers: [],
  exports: [],
  imports: [SenderIdentitiesModule]
})
export class RoutesSenderIdentitiesModule {}
