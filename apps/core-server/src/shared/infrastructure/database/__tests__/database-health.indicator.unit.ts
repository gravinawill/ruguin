import { describe, expect, it, vi } from 'vitest'

import { DatabaseHealthIndicator } from '../prisma/database-health.indicator'
import { type PrismaService } from '../prisma/prisma.service'

function createPrismaStub(behaviour: { rejectsWith?: Error }): PrismaService {
  return {
    $queryRaw: vi.fn(() =>
      behaviour.rejectsWith ? Promise.reject(behaviour.rejectsWith) : Promise.resolve([{ x: 1 }])
    )
  } as unknown as PrismaService
}

describe('DatabaseHealthIndicator', () => {
  it('reports up and measures latency when the query answers', async () => {
    const indicator = new DatabaseHealthIndicator(createPrismaStub({}))

    const result = await indicator.isHealthy('database')

    expect(result.database?.status).toBe('up')
    expect(result.database?.latencyInMs).toBeTypeOf('number')
  })

  it('reports down with the error message instead of propagating the exception', async () => {
    const indicator = new DatabaseHealthIndicator(createPrismaStub({ rejectsWith: new Error('connection refused') }))

    const result = await indicator.isHealthy('database')

    expect(result.database?.status).toBe('down')
    expect(result.database?.error).toBe('connection refused')
  })

  it('does not throw when the rejection is not an Error', async () => {
    const indicator = new DatabaseHealthIndicator(createPrismaStub({ rejectsWith: 'bare string' as unknown as Error }))

    const result = await indicator.isHealthy('database')

    expect(result.database?.status).toBe('down')
    expect(result.database?.error).toBe('Unknown failure while querying the database.')
  })

  it('collapses the multiline Prisma error into a single line', async () => {
    const multiline = new Error('\nInvalid `prisma.$queryRaw()` invocation:\n\n\n  Cannot reach database\n')
    const indicator = new DatabaseHealthIndicator(createPrismaStub({ rejectsWith: multiline }))

    const result = await indicator.isHealthy('database')

    expect(result.database?.error).toBe('Invalid `prisma.$queryRaw()` invocation: Cannot reach database')
  })

  it('truncates a long message so it does not bloat the health body', async () => {
    const longError = new Error('x'.repeat(500))
    const indicator = new DatabaseHealthIndicator(createPrismaStub({ rejectsWith: longError }))

    const result = await indicator.isHealthy('database')

    expect(String(result.database?.error)).toHaveLength(201)
    expect(String(result.database?.error).endsWith('…')).toBe(true)
  })

  it('uses the given key so the controller can name the indicator', async () => {
    const indicator = new DatabaseHealthIndicator(createPrismaStub({}))

    const result = await indicator.isHealthy('postgres')

    expect(Object.keys(result)).toEqual(['postgres'])
  })
})
