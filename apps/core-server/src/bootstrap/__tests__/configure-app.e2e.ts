import type { NestFastifyApplication } from '@nestjs/platform-fastify'

import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../app.module'
import { configureApp } from '../configure-app'

vi.hoisted(() => {
  process.env.ENVIRONMENT = 'test'
  process.env.CACHE_PREFIX = 'test-'
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/test'
  process.env.KAFKA_BOOTSTRAP_BROKERS = 'localhost:9092'
  process.env.KAFKA_CONSUMER_GROUP_ID = 'test-group'
  process.env.JWT_ACCESS_TOKEN_SECRET = 'test-access-secret'
  process.env.JWT_REFRESH_TOKEN_SECRET = 'test-refresh-secret'
  process.env.DOCS_USERNAME = 'test-docs-user'
  process.env.DOCS_PASSWORD = 'test-docs-pass'
})

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
      headers: { authorization: `Basic ${Buffer.from('test-docs-user:test-docs-pass').toString('base64')}` }
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
      headers: { authorization: `Basic ${Buffer.from('test-docs-user:test-docs-pass').toString('base64')}` }
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ openapi: expect.any(String) })
  })
})
