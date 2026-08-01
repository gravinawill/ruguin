import type { NestFastifyApplication } from '@nestjs/platform-fastify'

import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../../app.module'

/*
 * Its own file, not another describe block: @ruguin/env validates and freezes the cache schema the
 * first time cache.environment.ts is imported, so one module graph gets exactly one driver. Vitest
 * isolates files into separate workers, which is what lets this suite and the memory-backed one
 * disagree about CACHE_DRIVER.
 *
 * Requires the local stack:
 * docker compose -f infrastructure/local/docker-compose.yml up -d redis redis-replica
 */
vi.hoisted(() => {
  process.env.CACHE_PREFIX = 'ruguin:e2e-valkey'
  process.env.CACHE_DRIVER = 'valkey'
  process.env.CACHE_MASTER_URL = 'redis://localhost:6379'
  process.env.CACHE_REPLICA_URLS = 'redis://localhost:6380'
})

type CacheDetails = Readonly<{
  clientsRejectedTotal: number
  driver: string
  evictedKeys: number
  masterLatencyInMs: number
  masterReachable: boolean
  replicas: readonly unknown[]
  serverVersion: string
  status: string
}>

const context: { app: NestFastifyApplication | null } = { app: null }

const cacheDetails = async (): Promise<CacheDetails> => {
  const response = await context.app!.inject({ method: 'GET', url: '/health' })
  const body = JSON.parse(response.body) as { details: { cache: CacheDetails } }

  return body.details.cache
}

describe('GET /health against a live Valkey', () => {
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

  it('answers 200 and reports the master it actually reached', async () => {
    const response = await context.app!.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      details: { cache: { driver: 'valkey', masterReachable: true, status: 'up' } },
      status: 'ok'
    })
  })

  /*
   * The numbers spec §5.6 argues catch trouble before it becomes an incident. Asserting they are
   * present and numeric is the point — the values belong to whatever the server happens to be doing.
   */
  it('carries the server-reported pressure signals', async () => {
    const details = await cacheDetails()

    expect(details.serverVersion).toEqual(expect.any(String))
    expect(details.evictedKeys).toEqual(expect.any(Number))
    expect(details.clientsRejectedTotal).toEqual(expect.any(Number))
    expect(details.masterLatencyInMs).toEqual(expect.any(Number))
  })

  it('reports the configured replica', async () => {
    const details = await cacheDetails()

    expect(details.replicas).toHaveLength(1)
  })
})
