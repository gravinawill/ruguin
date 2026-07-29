import type { NestFastifyApplication } from '@nestjs/platform-fastify'

import { NestFactory } from '@nestjs/core'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Logger } from 'nestjs-pino'

import { AppModule } from './app.module'

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
  bufferLogs: true
})
app.useLogger(app.get(Logger))
await app.listen(process.env.PORT ?? 3000, '0.0.0.0')
