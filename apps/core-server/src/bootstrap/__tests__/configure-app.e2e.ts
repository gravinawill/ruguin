import type { NestFastifyApplication } from '@nestjs/platform-fastify'

import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../app.module'
import { configureApp } from '../configure-app'

describe('configureApp', () => {
  vi.stubEnv('DOCS_USERNAME', 'test-docs-user')
  vi.stubEnv('DOCS_PASSWORD', 'test-docs-pass')

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
})
