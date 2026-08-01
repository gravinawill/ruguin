import { Module } from '@nestjs/common'
import { CacheModule } from '@ruguin/cache/nestjs'
import { cacheENV } from '@ruguin/env/cache'
import { LoggerModule } from 'nestjs-pino'

import { createCacheModuleOptions } from './cache/cache-module-options'
import { HealthModule } from './health/health.module'
import { createPinoHttpOptions } from './logger/pino-http-options'

@Module({
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => ({ pinoHttp: createPinoHttpOptions(process.env) })
    }),

    CacheModule.forRoot({
      isGlobal: true,
      ...createCacheModuleOptions(cacheENV)
    }),
    HealthModule
  ],
  controllers: [],
  providers: []
})
export class AppModule {}
