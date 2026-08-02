import { Module } from '@nestjs/common'
import { CacheModule } from '@ruguin/cache'
import { cacheENV, databaseENV } from '@ruguin/env'
import { LoggerModule } from 'nestjs-pino'

import { createCacheModuleOptions } from './cache/cache-module-options'
import { HealthModule } from './health/health.module'
import { createPinoHttpOptions } from './logger/pino-http-options'
import { DatabaseModule } from './shared/database/database.module'
import { OutboxModule } from './shared/outbox/outbox.module'

@Module({
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => ({ pinoHttp: createPinoHttpOptions(process.env) })
    }),

    CacheModule.forRoot({
      isGlobal: true,
      ...createCacheModuleOptions(cacheENV)
    }),
    DatabaseModule.forRoot({ connectionString: databaseENV.DATABASE_URL }),
    OutboxModule,
    HealthModule
  ],
  controllers: [],
  providers: []
})
export class AppModule {}
