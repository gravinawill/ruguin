import { type NestFastifyApplication } from '@nestjs/platform-fastify'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../../app.module'

vi.hoisted(() => {
  process.env.CACHE_PREFIX = 'ruguin:e2e-down'
  process.env.CACHE_DRIVER = 'valkey'
  process.env.CACHE_MASTER_URL = 'redis://localhost:6399'
  process.env.CACHE_REPLICA_URLS = ''
})

describe('GET /health when the cache is unreachable', () => {
  const context: { app: NestFastifyApplication | null } = { app: null }

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()
    const app = moduleReference.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    context.app = app
  })

  afterAll(async () => {
    await context.app?.close()
  })

  it('answers 503 and names the cache as the indicator that is down', async () => {
    const response = await context.app!.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toMatchObject({ error: { cache: { status: 'down' } }, status: 'error' })
  })
})
