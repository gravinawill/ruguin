import { NestFactory } from '@nestjs/core'
import { type NestFastifyApplication } from '@nestjs/platform-fastify'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Logger } from 'nestjs-pino'

import { AppModule } from './app.module'
import { configureApp } from './bootstrap/configure-app'

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
  bufferLogs: true
})
app.useLogger(app.get(Logger))
/*
 * Without this, onApplicationShutdown only runs for an explicit app.close(); a SIGTERM from the
 * orchestrator would kill the process with the Valkey sockets still open, and the server would see
 * the client disappear rather than quit.
 */
app.enableShutdownHooks()
await configureApp(app)
await app.listen(process.env.PORT ?? 3000, '0.0.0.0')
