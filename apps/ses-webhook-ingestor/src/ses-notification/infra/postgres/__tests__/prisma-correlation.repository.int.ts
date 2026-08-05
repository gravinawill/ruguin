import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createTestPrismaService } from '../../../../shared/infrastructure/database/prisma/__tests__/database-test-context.ts'
import { type PrismaService } from '../../../../shared/infrastructure/database/prisma/prisma.service.ts'
import { PrismaCorrelationRepository } from '../prisma-correlation.repository.ts'

const context: { prisma: PrismaService | null } = { prisma: null }

const prisma = (): PrismaService => {
  if (context.prisma === null) throw new Error('prisma was never connected')
  return context.prisma
}

beforeAll(() => {
  context.prisma = createTestPrismaService()
})

afterEach(async () => {
  await prisma().sesMessageCorrelation.deleteMany({ where: { sesMessageId: { startsWith: 'int-test-' } } })
})

afterAll(async () => {
  await prisma().$disconnect()
})

describe('PrismaCorrelationRepository against a live Postgres', () => {
  it('returns null when looking up a sesMessageId that was never recorded', async () => {
    const repository = new PrismaCorrelationRepository(prisma())

    const result = await repository.lookup({ sesMessageId: 'int-test-never-seen' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value).toBeNull()
  })

  it('upserts a correlation and then finds it by lookup', async () => {
    const repository = new PrismaCorrelationRepository(prisma())

    const upserted = await repository.upsert({ sesMessageId: 'int-test-1', emailId: 'email-1' })
    expect(upserted.isSuccess()).toBe(true)

    const found = await repository.lookup({ sesMessageId: 'int-test-1' })
    expect(found.isSuccess()).toBe(true)
    if (found.isSuccess()) expect(found.value).toEqual({ emailId: 'email-1' })
  })

  it('is idempotent under a repeated upsert for the same sesMessageId', async () => {
    const repository = new PrismaCorrelationRepository(prisma())

    await repository.upsert({ sesMessageId: 'int-test-2', emailId: 'email-2' })
    const secondUpsert = await repository.upsert({ sesMessageId: 'int-test-2', emailId: 'email-2-retry' })

    expect(secondUpsert.isSuccess()).toBe(true)

    const found = await repository.lookup({ sesMessageId: 'int-test-2' })
    expect(found.isSuccess()).toBe(true)
    if (found.isSuccess()) expect(found.value).toEqual({ emailId: 'email-2' })
  })
})
