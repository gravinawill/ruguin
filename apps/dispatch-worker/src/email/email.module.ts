import { Module } from '@nestjs/common'
import { CacheModule } from '@ruguin/cache'
import { cacheENV } from '@ruguin/env'
import { MessageBrokerModule } from '@ruguin/message-broker'

import { createMessageBrokerModuleOptions } from '../shared/infrastructure/message-broker/message-broker-module-options.ts'

import { DEDUP_CLAIM_PROVIDER } from './application/providers/dedup-claim.port.ts'
import { EMAIL_SENDER_PROVIDER } from './application/providers/email-sender.port.ts'
import { RATE_LIMITER_PROVIDER } from './application/providers/rate-limiter.port.ts'
import { SendEmailUseCase } from './application/use-cases/send-email.use-case.ts'
import { EmailSendRequestedConsumer } from './consumers/email-send-requested.consumer.ts'
import { EmailSendRequestedRetryConsumer } from './consumers/email-send-requested-retry.consumer.ts'
import { RedisDedupClaim } from './infra/redis/redis-dedup-claim.ts'
import { RedisRateLimiter } from './infra/redis/redis-rate-limiter.ts'
import { sesClientProvider } from './infra/ses/ses-client.provider.ts'
import { SesEmailSender } from './infra/ses/ses-email-sender.ts'

@Module({
  imports: [
    CacheModule.forRoot({
      isGlobal: true,
      driver: cacheENV.CACHE_DRIVER,
      jitterRatio: cacheENV.CACHE_JITTER_RATIO,
      defaultTtlInMs: cacheENV.CACHE_DEFAULT_TTL_MS,
      defaultConsistency: cacheENV.CACHE_DEFAULT_CONSISTENCY,
      invalidationBroadcast: cacheENV.CACHE_INVALIDATION_BROADCAST,
      prefix: cacheENV.CACHE_PREFIX,
      negativeTtlInMs: cacheENV.CACHE_NEGATIVE_TTL_MS,
      lockTtlInMs: cacheENV.CACHE_OPERATION_TIMEOUT_MS * 10,
      operationTimeoutInMs: cacheENV.CACHE_OPERATION_TIMEOUT_MS,
      namespaceVersionLocalTtlInMs: cacheENV.CACHE_NS_VERSION_LOCAL_TTL_MS,
      replicationLagThresholdInBytes: cacheENV.CACHE_REPLICATION_LAG_THRESHOLD_BYTES,
      breaker: {
        failureThreshold: cacheENV.CACHE_BREAKER_FAILURE_THRESHOLD,
        resetTimeoutInMs: cacheENV.CACHE_BREAKER_RESET_TIMEOUT_MS
      },
      ...(cacheENV.CACHE_MASTER_URL !== undefined && { masterUrl: cacheENV.CACHE_MASTER_URL }),
      ...(cacheENV.CACHE_REPLICA_URLS.length > 0 && { replicaUrls: cacheENV.CACHE_REPLICA_URLS })
    }),
    MessageBrokerModule.forRoot({ isGlobal: true, ...createMessageBrokerModuleOptions() })
  ],
  providers: [
    sesClientProvider,
    { provide: DEDUP_CLAIM_PROVIDER, useClass: RedisDedupClaim },
    { provide: RATE_LIMITER_PROVIDER, useClass: RedisRateLimiter },
    { provide: EMAIL_SENDER_PROVIDER, useClass: SesEmailSender },
    SendEmailUseCase,
    EmailSendRequestedConsumer,
    EmailSendRequestedRetryConsumer
  ]
})
export class EmailModule {}
