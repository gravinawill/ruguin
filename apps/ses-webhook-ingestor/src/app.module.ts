import { Module } from '@nestjs/common'
import { CacheModule } from '@ruguin/cache'
import { cacheENV, databaseENV } from '@ruguin/env'
import { LoggerModule } from 'nestjs-pino'

import { HealthModule } from './health/health.module.ts'
import { DatabaseModule } from './shared/infrastructure/database/database.module.ts'
import { createPinoHttpOptions } from './shared/infrastructure/logger/pino-http-options.ts'

/*
 * Same Postgres instance/database as every other app (docs/superpowers/specs/2026-08-04-ses-webhook-ingestor-design.md
 * "Cada serviço possui seu próprio schema Postgres dentro da mesma instância") — isolation comes
 * from a distinct schema, not a distinct DATABASE_URL, since the whole monorepo shares one root
 * .env. PrismaService reads the schema back out of the connection string's `schema` query param
 * (see prisma.service.ts's resolveSchemaFrom).
 */
const DATABASE_SCHEMA = 'ses_webhook_ingestor'

export function withSchema(connectionString: string): string {
  const separator = connectionString.includes('?') ? '&' : '?'
  return `${connectionString}${separator}schema=${DATABASE_SCHEMA}`
}

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

    DatabaseModule.forRoot({
      connectionString: withSchema(databaseENV.DATABASE_URL)
    }),

    HealthModule
  ],
  controllers: [],
  providers: []
})
export class AppModule {}
