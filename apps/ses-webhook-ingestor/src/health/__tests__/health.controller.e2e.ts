import { type INestApplication } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../app.module.ts'

vi.hoisted(() => {
  process.env.CACHE_PREFIX = 'ruguin:e2e'
  process.env.CACHE_DRIVER = 'memory'
  process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin'
})

describe('GET /health', () => {
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

  it('returns 200 with cache and database reported as up', async () => {
    const response = await (app as unknown as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toMatchObject({
      status: 'ok',
      info: { cache: { status: 'up' }, database: { status: 'up' } }
    })
  })
})
