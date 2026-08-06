import { Controller, Get } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { BaseError, StatusError } from '@ruguin/shared-domain'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../../../app.module'
import { configureApp } from '../configure-app'

vi.hoisted(() => {
  process.env.DOCS_USERNAME = 'test-docs-user'
  process.env.DOCS_PASSWORD = 'test-docs-pass'
  process.env.CACHE_PREFIX = 'ruguin:e2e'
  process.env.CACHE_DRIVER = 'memory'
})

class TestConflictError extends BaseError {
  readonly name = 'TestConflictError'
  readonly status = StatusError.CONFLICT

  constructor() {
    super({ message: 'test conflict' })
  }
}

@Controller('__test-base-error')
class ThrowingTestController {
  @Get()
  throwError(): never {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- BaseError is caught by BaseErrorExceptionFilter, the pattern every guard/controller from Task 8 onward relies on; it deliberately does not extend Error
    throw new TestConflictError()
  }
}

function basicAuthHeader(username: string, password: string): string {
  const encoded = Buffer.from(`${username}:${password}`).toString('base64')
  return `Basic ${encoded}`
}

const VALID_CREDENTIALS = basicAuthHeader('test-docs-user', 'test-docs-pass')

describe('configureApp', () => {
  let app: NestFastifyApplication

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ThrowingTestController]
    }).compile()
    app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await configureApp(app)
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('maps a thrown BaseError to its StatusError-derived HTTP status via the global filter', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/__test-base-error' })

    expect(response.statusCode).toBe(409)
    expect(JSON.parse(response.body)).toEqual({ error: 'TestConflictError', message: 'test conflict' })
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

  it.each(['/%64ocs', '/%64ocs-json'])('rejects the percent-encoded path %s without credentials', async (url) => {
    const response = await app.inject({ method: 'GET', url })

    expect(response.statusCode).toBe(401)
  })

  it.each(['/docs/', '/DOCS', '/docs-json/'])('never serves %s unauthenticated', async (url) => {
    const response = await app.inject({ method: 'GET', url })

    expect(response.statusCode).not.toBe(200)
  })
})
