import { Module } from '@nestjs/common'

import { EmailsModule } from '../../emails.module'

@Module({
  controllers: [],
  providers: [],
  exports: [],
  imports: [EmailsModule]
})
export class RoutesEmailsModule {}
