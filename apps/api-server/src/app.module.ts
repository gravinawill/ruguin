import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'

import { HealthModule } from './health/health.module.js'
import { createPinoHttpOptions } from './logger/pino-http-options.js'

@Module({
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => ({ pinoHttp: createPinoHttpOptions(process.env) })
    }),
    HealthModule
  ],
  controllers: [],
  providers: []
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- this is a module
export class AppModule {}
