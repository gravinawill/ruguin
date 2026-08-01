import type { NestFastifyApplication } from '@nestjs/platform-fastify'

import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../app.module'
import { configureApp } from '../configure-app'

/*
 * AppModule now registers CacheModule, and @ruguin/env validates the cache schema at import time —
 * so these have to be in place before the module graph is built, which is what vi.hoisted buys.
 * The memory driver keeps this suite free of Docker; the Valkey-backed behaviour has its own suite.
 */
vi.hoisted(() => {
  process.env.DOCS_USERNAME = 'test-docs-user'
  process.env.DOCS_PASSWORD = 'test-docs-pass'
  process.env.CACHE_PREFIX = 'ruguin:e2e'
  process.env.CACHE_DRIVER = 'memory'
})

function basicAuthHeader(username: string, password: string): string {
  const encoded = Buffer.from(`${username}:${password}`).toString('base64')
  return `Basic ${encoded}`
}

const VALID_CREDENTIALS = basicAuthHeader('test-docs-user', 'test-docs-pass')

describe('configureApp', () => {
  let app: NestFastifyApplication

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await configureApp(app)
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('keeps /health version-neutral (no /v1 prefix)', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ status: 'ok' })
  })

  it('applies helmet security headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.headers['x-content-type-options']).toBe('nosniff')
  })

  it('rejects /docs without credentials', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs' })

    expect(response.statusCode).toBe(401)
  })

  it('serves /docs with correct credentials', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs',
      headers: { authorization: VALID_CREDENTIALS }
    })

    expect(response.statusCode).toBe(200)
  })

  it('rejects /docs-json without credentials', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs-json' })

    expect(response.statusCode).toBe(401)
  })

  it('serves the OpenAPI document at /docs-json with correct credentials', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs-json',
      headers: { authorization: VALID_CREDENTIALS }
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ openapi: expect.any(String) })
  })

  it.each([
    { credentials: basicAuthHeader('wrong-user', 'test-docs-pass'), label: 'wrong username' },
    { credentials: basicAuthHeader('test-docs-user', 'wrong-pass'), label: 'wrong password' }
  ])('rejects /docs with $label', async ({ credentials }) => {
    const response = await app.inject({ method: 'GET', url: '/docs', headers: { authorization: credentials } })

    expect(response.statusCode).toBe(401)
  })

  it.each([
    { credentials: basicAuthHeader('wrong-user', 'test-docs-pass'), label: 'wrong username' },
    { credentials: basicAuthHeader('test-docs-user', 'wrong-pass'), label: 'wrong password' }
  ])('rejects /docs-json with $label', async ({ credentials }) => {
    const response = await app.inject({ method: 'GET', url: '/docs-json', headers: { authorization: credentials } })

    expect(response.statusCode).toBe(401)
  })

  /*
   * Fastify's router percent-decodes the path before matching, so `/%64ocs-json` resolves to the
   * `/docs-json` handler. A guard that string-matched the raw URL let these through unauthenticated.
   */
  it.each(['/%64ocs', '/%64ocs-json'])('rejects the percent-encoded path %s without credentials', async (url) => {
    const response = await app.inject({ method: 'GET', url })

    expect(response.statusCode).toBe(401)
  })

  it.each(['/docs/', '/DOCS', '/docs-json/'])('never serves %s unauthenticated', async (url) => {
    const response = await app.inject({ method: 'GET', url })

    expect(response.statusCode).not.toBe(200)
  })
})
