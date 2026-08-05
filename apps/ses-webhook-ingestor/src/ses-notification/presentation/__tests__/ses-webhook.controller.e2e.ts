import { type INestApplication } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../../app.module.ts'
import { SES_INGESTOR_SECRET_HEADER } from '../ses-webhook-auth.guard.ts'

const SHARED_SECRET = 'e2e-shared-secret'

vi.hoisted(() => {
  process.env.CACHE_PREFIX = 'ruguin:e2e-webhook'
  process.env.CACHE_DRIVER = 'memory'
  process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin'
  process.env.SES_WEBHOOK_INGESTOR_SHARED_SECRET = 'e2e-shared-secret'
})

describe('POST /webhooks/ses', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()

    app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.init()
    await (app as unknown as NestFastifyApplication).getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 401 when the secret header is missing', async () => {
    const response = await (app as unknown as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'POST', url: '/webhooks/ses', payload: {} })

    expect(response.statusCode).toBe(401)
  })

  it('returns 401 when the secret header is wrong', async () => {
    const response = await (app as unknown as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/webhooks/ses',
        headers: { [SES_INGESTOR_SECRET_HEADER]: 'wrong-secret' },
        payload: {}
      })

    expect(response.statusCode).toBe(401)
  })

  it('returns 200 for a malformed body once authenticated', async () => {
    const response = await (app as unknown as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/webhooks/ses',
        headers: { [SES_INGESTOR_SECRET_HEADER]: SHARED_SECRET },
        payload: { not: 'valid' }
      })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toEqual({ status: 'ok' })
  })

  it('returns 200 for a well-formed notification with no correlation yet', async () => {
    const response = await (app as unknown as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/webhooks/ses',
        headers: { [SES_INGESTOR_SECRET_HEADER]: SHARED_SECRET },
        payload: {
          id: 'evt-e2e-1',
          source: 'aws.ses',
          detail: { eventType: 'Delivery', mail: { messageId: `int-test-e2e-${Date.now()}` } }
        }
      })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toEqual({ status: 'ok' })
  })
})
