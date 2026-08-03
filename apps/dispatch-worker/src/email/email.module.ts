import { Module } from '@nestjs/common'
import { awsENV } from '@ruguin/env'

import { DEDUP_CLAIM_PROVIDER } from './application/providers/dedup-claim.port.ts'
import { EMAIL_SENDER_PROVIDER } from './application/providers/email-sender.port.ts'
import { RATE_LIMITER_PROVIDER } from './application/providers/rate-limiter.port.ts'
import { SendEmailUseCase, SES_RATE_LIMIT_PER_SECOND_PROVIDER } from './application/use-cases/send-email.use-case.ts'
import { EmailSendRequestedConsumer } from './consumers/email-send-requested.consumer.ts'
import { EmailSendRequestedRetryConsumer } from './consumers/email-send-requested-retry.consumer.ts'
import { RedisDedupClaim } from './infra/redis/redis-dedup-claim.ts'
import { RedisRateLimiter } from './infra/redis/redis-rate-limiter.ts'
import { sesClientProvider } from './infra/ses/ses-client.provider.ts'
import { SesEmailSender } from './infra/ses/ses-email-sender.ts'

/*
 * CacheModule and MessageBrokerModule are registered once, globally, in AppModule — see the
 * comment there. This module only owns the email bounded-context's own providers.
 */
@Module({
  providers: [
    sesClientProvider,
    { provide: DEDUP_CLAIM_PROVIDER, useClass: RedisDedupClaim },
    { provide: RATE_LIMITER_PROVIDER, useClass: RedisRateLimiter },
    { provide: EMAIL_SENDER_PROVIDER, useClass: SesEmailSender },
    /*
     * useFactory, not useValue — a useValue provider evaluates awsENV.SES_SEND_RATE_LIMIT_PER_SECOND
     * the moment this module's providers array is built (i.e. as soon as email.module.ts is
     * imported), which would force AWS_* env vars to be present just to import the module. A
     * factory defers that read to actual DI resolution, matching sesClientProvider above.
     */
    { provide: SES_RATE_LIMIT_PER_SECOND_PROVIDER, useFactory: (): number => awsENV.SES_SEND_RATE_LIMIT_PER_SECOND },
    SendEmailUseCase,
    EmailSendRequestedConsumer,
    EmailSendRequestedRetryConsumer
  ]
})
export class EmailModule {}
