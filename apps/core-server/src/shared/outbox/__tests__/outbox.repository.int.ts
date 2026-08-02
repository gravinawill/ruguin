import { BaseError, Event, StatusError } from '@ruguin/ddd-kernel'
import { type Either, failure } from '@ruguin/utils'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { type PrismaService } from '../../database/prisma.service'
import { PrismaTransactionManager } from '../../database/prisma-transaction-manager'
import { OutboxRepository } from '../outbox.repository'

import { createTestPrismaService } from './outbox-test-context'

const MODULE = 'outbox-repository-int-test'

class RollbackTestError extends BaseError {
  readonly name = 'RollbackTestError'
  readonly status = StatusError.CONFLICT

  constructor() {
    super({ message: 'forced rollback for the atomicity test' })
  }
}

const context: { prisma: PrismaService | null } = { prisma: null }

const prisma = (): PrismaService => {
  if (context.prisma === null) throw new Error('prisma was never connected')
  return context.prisma
}

beforeAll(() => {
  context.prisma = createTestPrismaService()
})

afterEach(async () => {
  await prisma().outboxMessage.deleteMany({ where: { module: MODULE } })
})

afterAll(async () => {
  await prisma().$disconnect()
})

describe('OutboxRepository against a live Postgres, inside PrismaTransactionManager', () => {
  it('persists the row when the transaction commits', async () => {
    const manager = new PrismaTransactionManager(prisma())
    const repository = new OutboxRepository(MODULE)
    const event = Event.create('test.committed', { ok: true })

    const result = await manager.execute((tx) =>
      repository.enqueue(event, { key: 'commit-case', topic: 'test-topic' }, tx)
    )

    expect(result.isSuccess()).toBe(true)

    const stored = await prisma().outboxMessage.findMany({ where: { eventId: event.id.toString() } })
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ key: 'commit-case', status: 'PENDING', topic: 'test-topic' })
  })

  it('rolls back the row when the transaction fails after enqueueing', async () => {
    const manager = new PrismaTransactionManager(prisma())
    const repository = new OutboxRepository(MODULE)
    const event = Event.create('test.rolled-back', { ok: false })

    const result = await manager.execute(async (tx): Promise<Either<BaseError, void>> => {
      const enqueued = await repository.enqueue(event, { key: 'rollback-case', topic: 'test-topic' }, tx)
      if (enqueued.isFailure()) return enqueued

      return failure(new RollbackTestError())
    })

    expect(result.isFailure()).toBe(true)

    const stored = await prisma().outboxMessage.findMany({ where: { eventId: event.id.toString() } })
    expect(stored).toHaveLength(0)
  })
})
