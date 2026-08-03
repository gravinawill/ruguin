import { Module } from '@nestjs/common'
import { CacheModule } from '@ruguin/cache'
import { cacheENV } from '@ruguin/env'
import { MessageBrokerModule } from '@ruguin/message-broker'
import { LoggerModule } from 'nestjs-pino'

import { EmailModule } from './email/email.module.ts'
import { HealthModule } from './health/health.module.ts'
import { createPinoHttpOptions } from './shared/infrastructure/logger/pino-http-options.ts'
import { createMessageBrokerModuleOptions } from './shared/infrastructure/message-broker/message-broker-module-options.ts'

@Module({
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => ({
        pinoHttp: createPinoHttpOptions()
      })
    }),

    /*
     * Registered here, not inside EmailModule — a feature module owning a global provider means
     * anything that depends on it (HealthModule's CacheHealthIndicator) only works by accident of
     * import order in this array. AppModule is this repo's established place for app-wide
     * infrastructure (apps/core-server/src/app.module.ts does the same for CacheModule).
     */
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

    EmailModule,
    HealthModule
  ],
  controllers: [],
  providers: []
})
export class AppModule {}
