import { type INestApplication } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../app.module.ts'

vi.hoisted(() => {
  process.env.CACHE_PREFIX = 'ruguin:e2e-db-down'
  process.env.CACHE_DRIVER = 'memory'
  // Deliberately unreachable — proves the health check reports "down" instead of hanging or throwing.
  process.env.DATABASE_URL = 'postgresql://ruguin:ruguin@localhost:1/ruguin'
})

describe('GET /health with Postgres unreachable', () => {
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

  it('returns 503 with database reported as down', async () => {
    const response = await (app as unknown as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.payload)).toMatchObject({ status: 'error', error: { database: { status: 'down' } } })
  }, 15_000)
})
