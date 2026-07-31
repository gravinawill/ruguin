import crypto from 'node:crypto'

import basicAuth from '@fastify/basic-auth'
import compress from '@fastify/compress'
import helmet from '@fastify/helmet'
import { VersioningType } from '@nestjs/common'
import { type NestFastifyApplication } from '@nestjs/platform-fastify'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { docsENV } from '@ruguin/env'
import { apiReference } from '@scalar/nestjs-api-reference'

export async function configureApp(app: NestFastifyApplication): Promise<void> {
  await app.register(helmet)
  await app.register(compress)

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })

  await app.register(basicAuth, {
    validate: async (username: string, password: string) => {
      await Promise.resolve()
      const candidateHash = crypto.createHash('sha256').update(`${username}:${password}`).digest()
      const expectedHash = crypto
        .createHash('sha256')
        .update(`${docsENV.DOCS_USERNAME}:${docsENV.DOCS_PASSWORD}`)
        .digest()
      if (!crypto.timingSafeEqual(candidateHash, expectedHash)) throw new Error('Invalid credentials')
    },
    authenticate: true
  })

  const fastify = app.getHttpAdapter().getInstance()
  fastify.addHook('onRequest', (request, reply, done) => {
    if (!request.url.startsWith('/docs')) {
      done()
      return
    }
    fastify.basicAuth(request, reply, done)
  })

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Core Server API')
      .setDescription('API interna do core-server — health check e endpoints de negócio futuros.')
      .setVersion('0.0.1')
      .build()
  )

  app.use('/docs', apiReference({ withFastify: true, content: document }))
  app.getHttpAdapter().get('/docs-json', (_request, reply) => {
    reply.send(document)
  })
}
