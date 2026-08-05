import { Module } from '@nestjs/common'

import { OutboxModule } from '../../shared/infrastructure/outbox/outbox.module'
import { ApiKeysModule } from '../api-keys/api-keys.module'
import { TemplatesModule } from '../templates/templates.module'

import { SendEmailService } from './application/services/send-email.service'
import { SendEmailUseCase } from './application/use-cases/send-email.use-case'
import { EMAIL_REPOSITORY } from './domain/contracts/repositories/email.repository'
import { EmailRepository } from './infrastructure/database/prisma/email.repository'
import { EmailController } from './presentation/controllers/email.controller'

@Module({
  imports: [ApiKeysModule, TemplatesModule, OutboxModule.forFeature({ module: 'email' })],
  controllers: [EmailController],
  providers: [
    EmailRepository,
    { provide: EMAIL_REPOSITORY, useExisting: EmailRepository },
    SendEmailUseCase,
    SendEmailService
  ]
})
export class EmailsModule {}
