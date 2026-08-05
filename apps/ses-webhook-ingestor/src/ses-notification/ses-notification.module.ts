import { Module } from '@nestjs/common'

import { CORRELATION_PROVIDER } from './application/providers/correlation.port.ts'
import { DEDUP_CLAIM_PROVIDER } from './application/providers/dedup-claim.port.ts'
import { IngestSesNotificationUseCase } from './application/use-cases/ingest-ses-notification.use-case.ts'
import { RecordSentCorrelationUseCase } from './application/use-cases/record-sent-correlation.use-case.ts'
import { ResolvePendingCorrelationUseCase } from './application/use-cases/resolve-pending-correlation.use-case.ts'
import { EmailStatusUpdatedSentConsumer } from './consumers/email-status-updated-sent.consumer.ts'
import { SesNotificationCorrelationRetryConsumer } from './consumers/ses-notification-correlation-retry.consumer.ts'
import { PrismaCorrelationRepository } from './infra/postgres/prisma-correlation.repository.ts'
import { RedisDedupClaim } from './infra/redis/redis-dedup-claim.ts'
import { SesWebhookController } from './presentation/ses-webhook.controller.ts'

@Module({
  controllers: [SesWebhookController],
  providers: [
    { provide: CORRELATION_PROVIDER, useClass: PrismaCorrelationRepository },
    { provide: DEDUP_CLAIM_PROVIDER, useClass: RedisDedupClaim },
    RecordSentCorrelationUseCase,
    IngestSesNotificationUseCase,
    ResolvePendingCorrelationUseCase,
    EmailStatusUpdatedSentConsumer,
    SesNotificationCorrelationRetryConsumer
  ]
})
export class SesNotificationModule {}
