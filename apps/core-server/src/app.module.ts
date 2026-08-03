import { Module } from '@nestjs/common'
import { CacheModule } from '@ruguin/cache'
import { databaseENV } from '@ruguin/env'
import { LoggerModule } from 'nestjs-pino'

import { HealthModule } from './modules/health/health.module'
import { createCacheModuleOptions } from './shared/infrastructure/cache/cache-module-options'
import { DatabaseModule } from './shared/infrastructure/database/database.module'
import { createPinoHttpOptions } from './shared/infrastructure/logger/pino-http-options'
import { OutboxModule } from './shared/infrastructure/outbox/outbox.module'

@Module({
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => ({
        pinoHttp: createPinoHttpOptions()
      })
    }),

    CacheModule.forRoot({
      isGlobal: true,
      ...createCacheModuleOptions()
    }),

    DatabaseModule.forRoot({
      connectionString: databaseENV.DATABASE_URL
    }),

    OutboxModule.forRoot(),
    HealthModule
  ],
  controllers: [],
  providers: []
})
export class AppModule {}
