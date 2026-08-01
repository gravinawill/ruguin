import type { INestApplication } from '@nestjs/common'

import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../app.module'

/* @ruguin/env validates the cache schema at import time; vi.hoisted runs before the module graph. */
vi.hoisted(() => {
  process.env.CACHE_PREFIX = 'ruguin:e2e'
  process.env.CACHE_DRIVER = 'memory'
})

describe('GET /health (e2e)', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleReference.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 200 with status ok', async () => {
    const response = await request(app.getHttpServer() as Parameters<typeof request>[0]).get('/health')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ status: 'ok' })
  })
})
