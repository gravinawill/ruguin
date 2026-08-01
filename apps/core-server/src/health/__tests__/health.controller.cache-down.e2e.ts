import type { NestFastifyApplication } from '@nestjs/platform-fastify'

import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../app.module'

/*
 * Port 6399 has nothing behind it. No Docker needed: the point is what the application does when
 * the cache is gone, and a refused connection is the cheapest way to be sure it is.
 */
vi.hoisted(() => {
  process.env.CACHE_PREFIX = 'ruguin:e2e-down'
  process.env.CACHE_DRIVER = 'valkey'
  process.env.CACHE_MASTER_URL = 'redis://localhost:6399'
  process.env.CACHE_REPLICA_URLS = ''
})

describe('GET /health when the cache is unreachable', () => {
  const context: { app: NestFastifyApplication | null } = { app: null }

  /*
   * That this beforeAll finishes at all is half the assertion: CacheModule.onModuleInit reports a
   * failed connect and lets the boot continue, because a Valkey outage must not be an API outage.
   */
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
