import { type NestFastifyApplication } from '@nestjs/platform-fastify'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../../../app.module'
import { configureApp } from '../configure-app'

vi.hoisted(() => {
  process.env.DOCS_USERNAME = 'test-docs-user'
  process.env.DOCS_PASSWORD = 'test-docs-pass'
  process.env.CACHE_PREFIX = 'ruguin:e2e'
  process.env.CACHE_DRIVER = 'memory'
})

const VALID_CREDENTIALS = `Basic ${Buffer.from('test-docs-user:test-docs-pass').toString('base64')}`

describe('configureApp over a real HTTP listener', () => {
  let app: NestFastifyApplication
  let baseUrl: string

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await configureApp(app)
    await app.init()
    await app.listen(0, '127.0.0.1')
    baseUrl = await app.getUrl()
  })

  afterAll(async () => {
    await app.close()
  })

  it('serves /health without credentials', async () => {
    const response = await fetch(`${baseUrl}/health`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok' })
  })

  it.each(['/docs', '/docs-json'])('rejects %s without credentials', async (path) => {
    const response = await fetch(`${baseUrl}${path}`)

    expect(response.status).toBe(401)
  })

  /*
   * The router percent-decodes before matching, so these reach the /docs handlers. A guard that
   * string-matched the raw request URL served them unauthenticated.
   */
  it.each(['/%64ocs', '/%64ocs-json'])('rejects the percent-encoded path %s without credentials', async (path) => {
    const response = await fetch(`${baseUrl}${path}`)

    expect(response.status).toBe(401)
  })

  it('serves the OpenAPI document at /docs-json with correct credentials', async () => {
    const response = await fetch(`${baseUrl}/docs-json`, { headers: { authorization: VALID_CREDENTIALS } })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ openapi: expect.any(String) })
  })

  it('serves /docs with a CSP that permits the scripts in its own body', async () => {
    const response = await fetch(`${baseUrl}/docs`, { headers: { authorization: VALID_CREDENTIALS } })
    const html = await response.text()

    expect(response.status).toBe(200)

    const scriptTags = html.match(/<script[^>]*>/g) ?? []
    expect(scriptTags).toHaveLength(2)

    const nonce = /<script[^>]*\snonce="([^"]+)"/.exec(html)?.[1]
    expect(nonce).toBeDefined()
    // Both the CDN bundle and the inline init script must carry the same nonce.
    for (const tag of scriptTags) expect(tag).toContain(`nonce="${nonce}"`)
    expect(html).toContain('<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"')

    const scriptSource = (response.headers.get('content-security-policy') ?? '')
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('script-src '))

    expect(scriptSource).toContain('https://cdn.jsdelivr.net')
    expect(scriptSource).toContain(`'nonce-${nonce}'`)
    expect(scriptSource).not.toContain("'unsafe-inline'")
  })

  it('keeps the CDN allowance scoped to /docs', async () => {
    const response = await fetch(`${baseUrl}/health`)

    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(response.headers.get('content-security-policy')).not.toContain('cdn.jsdelivr.net')
  })
})
