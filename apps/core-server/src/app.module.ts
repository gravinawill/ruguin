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
    /*
     * Global: the cache is infrastructure every feature module may reach for, and making each one
     * import CacheModule would only add ceremony — the tokens are still what decides how much of the
     * surface a given constructor sees.
     */
    CacheModule.forRoot({ isGlobal: true, ...createCacheModuleOptions(cacheENV) }),
    HealthModule
  ],
  controllers: [],
  providers: []
})
export class AppModule {}
