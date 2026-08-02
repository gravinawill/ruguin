import { Module } from '@nestjs/common'
import { CacheModule } from '@ruguin/cache'
import { databaseENV } from '@ruguin/env'
import { MessageBrokerModule } from '@ruguin/message-broker'
import { LoggerModule } from 'nestjs-pino'

import { HealthModule } from './modules/health/health.module'
import { createCacheModuleOptions } from './shared/infrastructure/cache/cache-module-options'
import { DatabaseModule } from './shared/infrastructure/database/database.module'
import { createPinoHttpOptions } from './shared/infrastructure/logger/pino-http-options'
import { createMessageBrokerModuleOptions } from './shared/infrastructure/message-broker/message-broker-module-options'

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

    MessageBrokerModule.forRoot({
      isGlobal: true,
      ...createMessageBrokerModuleOptions()
    }),

    DatabaseModule.forRoot({
      connectionString: databaseENV.DATABASE_URL
    }),

    HealthModule
  ],
  controllers: [],
  providers: []
})
export class AppModule {}
