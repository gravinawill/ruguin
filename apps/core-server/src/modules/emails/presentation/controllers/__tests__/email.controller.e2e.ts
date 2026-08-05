import { randomUUID } from 'node:crypto'

import { type NestFastifyApplication } from '@nestjs/platform-fastify'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { testSeedENV } from '@ruguin/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AppModule } from '../../../../../app.module'
import { configureApp } from '../../../../../shared/infrastructure/bootstrap/configure-app'

const SEEDED_TEMPLATE_ID = testSeedENV.TEST_SEEDED_TEMPLATE_ID
const SEEDED_API_KEY = testSeedENV.TEST_SEEDED_API_KEY

describe('POST /v1/emails (e2e)', () => {
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

  // --- EMAIL-3 acceptance criteria ---

  it('returns 401 for a request with no Authorization header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      payload: { from: 'sender@example.com', to: 'recipient@example.com', subject: 'Hi', html: '<p>Hi</p>' }
    })

    expect(response.statusCode).toBe(401)
  })

  it('returns 401 for an unknown API key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: 'Bearer not-a-real-key' },
      payload: { from: 'sender@example.com', to: 'recipient@example.com', subject: 'Hi', html: '<p>Hi</p>' }
    })

    expect(response.statusCode).toBe(401)
  })

  it('GET /health responds 200 without any authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
  })

  // --- EMAIL-4 acceptance criteria ---

  it('accepts a templateId + variables request, persists the rendered content, and returns 202', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: {
        from: 'sender@example.com',
        to: 'recipient@example.com',
        templateId: SEEDED_TEMPLATE_ID,
        variables: { name: 'Ada' }
      }
    })

    expect(response.statusCode).toBe(202)
    expect(JSON.parse(response.body)).toMatchObject({ status: 'queued' })
  })

  it('returns 400 when the body has neither templateId nor subject+html', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: { from: 'sender@example.com', to: 'recipient@example.com' }
    })

    expect(response.statusCode).toBe(400)
  })

  it('returns 404 for a templateId belonging to a different project', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: {
        from: 'sender@example.com',
        to: 'recipient@example.com',
        templateId: randomUUID(),
        variables: {}
      }
    })

    expect(response.statusCode).toBe(404)
  })

  it('returns 422 when the template references a variable that was not provided', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${SEEDED_API_KEY}` },
      payload: {
        from: 'sender@example.com',
        to: 'recipient@example.com',
        templateId: SEEDED_TEMPLATE_ID,
        variables: {}
      }
    })

    expect(response.statusCode).toBe(422)
  })

  it('returns the same id for two concurrent requests sharing an Idempotency-Key', async () => {
    const idempotencyKey = `idem-${randomUUID()}`
    const payload = { from: 'sender@example.com', to: 'recipient@example.com', subject: 'Hi', html: '<p>Hi</p>' }

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/emails',
        headers: { authorization: `Bearer ${SEEDED_API_KEY}`, 'idempotency-key': idempotencyKey },
        payload
      }),
      app.inject({
        method: 'POST',
        url: '/v1/emails',
        headers: { authorization: `Bearer ${SEEDED_API_KEY}`, 'idempotency-key': idempotencyKey },
        payload
      })
    ])

    expect(first.statusCode).toBe(202)
    expect(second.statusCode).toBe(202)
    expect(JSON.parse(first.body).id).toBe(JSON.parse(second.body).id)
  })
})
