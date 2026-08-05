import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Logger } from 'nestjs-pino'

import { AppModule } from './app.module.ts'

/*
 * Not read from @ruguin/env's serverENV.PORT — this repo loads one shared root .env for every
 * app (see apps/dispatch-worker/src/main.ts's identical comment), so a runtime-configurable PORT
 * would collide with core-server/dispatch-worker whenever more than one runs locally at once.
 * dispatch-worker took 3334; this is the next free slot.
 */
const PORT = 3335

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
  bufferLogs: true
})
app.useLogger(app.get(Logger))
app.enableShutdownHooks()
await app.listen(PORT, '0.0.0.0')
