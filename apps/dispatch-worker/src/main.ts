import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Logger } from 'nestjs-pino'

import { AppModule } from './app.module.ts'

/*
 * Not read from `@ruguin/env`'s serverENV.PORT on purpose: this repo loads one shared root .env
 * via `pnpm with-env` for every app, so serverENV.PORT resolves to the exact same value (or the
 * same 3333 default) regardless of which app reads it — using it here would collide with
 * core-server whenever both run locally at once. This worker has no HTTP surface beyond /health,
 * so a dedicated, runtime-configurable PORT isn't worth a new @ruguin/env variable yet; revisit if
 * that changes.
 */
const PORT = 3334

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
  bufferLogs: true
})
app.useLogger(app.get(Logger))
app.enableShutdownHooks()
await app.listen(PORT, '0.0.0.0')
