import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'

import { HealthModule } from './health/health.module'
import { createPinoHttpOptions } from './logger/pino-http-options'

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
export class AppModule {}
