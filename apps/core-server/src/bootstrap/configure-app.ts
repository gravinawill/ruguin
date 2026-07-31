import crypto from 'node:crypto'
import { type ServerResponse } from 'node:http'

import basicAuth from '@fastify/basic-auth'
import compress from '@fastify/compress'
import helmet from '@fastify/helmet'
import { VersioningType } from '@nestjs/common'
import { type NestFastifyApplication } from '@nestjs/platform-fastify'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { docsENV } from '@ruguin/env/docs'
import { apiReference } from '@scalar/nestjs-api-reference'

/* Origin of the standalone bundle Scalar's rendered HTML loads via <script src>. */
const SCALAR_CDN_ORIGIN = 'https://cdn.jsdelivr.net'

const documentationNonces = new WeakMap<ServerResponse, string>()

/*
 * One nonce per response, shared by the CSP header and the rendered HTML. Scalar stamps a single
 * nonce onto every tag it emits, so helmet's `enableCSPNonces` (separate script and style nonces)
 * cannot be used here — the style tag would carry the script nonce and be blocked.
 */
function documentationNonce(response: ServerResponse): string {
  const existing = documentationNonces.get(response)
  if (existing !== undefined) return existing

  const nonce = crypto.randomBytes(16).toString('base64')
  documentationNonces.set(response, nonce)
  return nonce
}

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

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Core Server API')
      .setDescription('API interna do core-server — health check e endpoints de negócio futuros.')
      .setVersion('0.0.1')
      .build()
  )

  const fastify = app.getHttpAdapter().getInstance()

  /*
   * Basic Auth is attached per route rather than by matching request.url in a global hook: Fastify's
   * router percent-decodes the path before matching, so a global string check and the router can
   * disagree (`/%64ocs-json` skipped the check but still reached the handler). A route-scoped
   * onRequest hook runs in the context of whatever route the router actually resolved.
   */
  fastify.get(
    '/docs',
    {
      onRequest: fastify.basicAuth,
      /*
       * Helmet's default `script-src 'self'` blocks both scripts Scalar emits. Loosened for this
       * route only: the CDN bundle by origin, the inline init script by nonce. Every other
       * directive stays at helmet's default.
       */
      helmet: {
        contentSecurityPolicy: {
          useDefaults: true,
          directives: {
            'script-src': [
              "'self'",
              SCALAR_CDN_ORIGIN,
              (_request, response) => `'nonce-${documentationNonce(response)}'`
            ]
          }
        }
      }
    },
    (request, reply) => {
      reply.hijack()
      const renderDocumentation = apiReference({
        withFastify: true,
        content: document,
        nonce: documentationNonce(reply.raw)
      })
      /*
       * Scalar's apiReference handler with withFastify:true is a raw Node handler (writes directly to
       * res via writeHead/write/end), not a Fastify route handler — it needs the raw res object.
       */
      // @ts-expect-error - Scalar handler expects Node's IncomingMessage/ServerResponse, not Fastify's wrapper types
      renderDocumentation(request.raw, reply.raw)
    }
  )

  fastify.get('/docs-json', { onRequest: fastify.basicAuth }, (_request, reply) => {
    reply.send(document)
  })
}
