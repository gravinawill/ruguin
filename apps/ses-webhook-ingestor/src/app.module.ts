import { Module } from '@nestjs/common'
import { CacheModule } from '@ruguin/cache'
import { cacheENV, databaseENV, sesWebhookIngestorENV } from '@ruguin/env'
import { MessageBrokerModule } from '@ruguin/message-broker'
import { LoggerModule } from 'nestjs-pino'

import { HealthModule } from './health/health.module.ts'
import { SesNotificationModule } from './ses-notification/ses-notification.module.ts'
import { DatabaseModule } from './shared/infrastructure/database/database.module.ts'
import { withSchema } from './shared/infrastructure/database/database-schema.ts'
import { createPinoHttpOptions } from './shared/infrastructure/logger/pino-http-options.ts'
import { createMessageBrokerModuleOptions } from './shared/infrastructure/message-broker/message-broker-module-options.ts'

/*
 * Touched here, not only inside SesWebhookAuthGuard, so a missing secret crashes AppModule's
 * bootstrap immediately — the alternative (validated lazily, only on the first webhook request)
 * means the app boots green, /health returns 200, and every webhook request 500s forever, which is
 * exactly the status code that makes EventBridge retry indefinitely against a service that looks
 * healthy.
 */
// eslint-disable-next-line sonarjs/void-use -- intentional: forces the lazy env getter to run (and throw) now, not on first webhook request
void sesWebhookIngestorENV.SES_WEBHOOK_INGESTOR_SHARED_SECRET

@Module({
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => ({
        pinoHttp: createPinoHttpOptions()
      })
    }),

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

    MessageBrokerModule.forRoot({ isGlobal: true, ...createMessageBrokerModuleOptions() }),

    DatabaseModule.forRoot({
      connectionString: withSchema(databaseENV.DATABASE_URL)
    }),

    SesNotificationModule,
    HealthModule
  ],
  controllers: [],
  providers: []
})
export class AppModule {}
