import { Module } from '@nestjs/common'

import { CORRELATION_PROVIDER } from './application/providers/correlation.port.ts'
import { RecordSentCorrelationUseCase } from './application/use-cases/record-sent-correlation.use-case.ts'
import { EmailStatusUpdatedSentConsumer } from './consumers/email-status-updated-sent.consumer.ts'
import { PrismaCorrelationRepository } from './infra/postgres/prisma-correlation.repository.ts'

@Module({
  providers: [
    { provide: CORRELATION_PROVIDER, useClass: PrismaCorrelationRepository },
    RecordSentCorrelationUseCase,
    EmailStatusUpdatedSentConsumer
  ]
})
export class SesNotificationModule {}
