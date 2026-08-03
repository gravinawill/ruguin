import { Module } from '@nestjs/common'
import { CacheModule } from '@ruguin/cache'
import { databaseENV } from '@ruguin/env'
import { LoggerModule } from 'nestjs-pino'

import { RouterModule } from './router/router.module'
import { createCacheModuleOptions } from './shared/infrastructure/cache/cache-module-options'
import { DatabaseModule } from './shared/infrastructure/database/database.module'
import { createPinoHttpOptions } from './shared/infrastructure/logger/pino-http-options'

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

    RouterModule
  ]
})
export class AppModule {}
