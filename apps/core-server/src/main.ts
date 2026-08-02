import { NestFactory } from '@nestjs/core'
import { type NestFastifyApplication } from '@nestjs/platform-fastify'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { serverENV } from '@ruguin/env'
import { Logger } from 'nestjs-pino'

import { AppModule } from './app.module'
import { configureApp } from './shared/infrastructure/bootstrap/configure-app'

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
  bufferLogs: true
})
app.useLogger(app.get(Logger))
app.enableShutdownHooks()
await configureApp(app)
await app.listen(serverENV.PORT, '0.0.0.0')
