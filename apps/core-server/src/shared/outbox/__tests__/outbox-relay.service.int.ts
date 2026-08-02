import { Event } from '@ruguin/ddd-kernel'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { type PrismaService } from '../../database/prisma.service'
import { PrismaTransactionManager } from '../../database/prisma-transaction-manager'
import { FakeMessageProducer } from '../../events/fake-message-producer'
import { OutboxRepository } from '../outbox.repository'
import { OutboxRelayService } from '../outbox-relay.service'

import { createTestPrismaService, sleep } from './outbox-test-context'

const MODULE = 'outbox-relay-int-test'
const TICKS = 6

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

describe('OutboxRelayService against a live Postgres, with two concurrent instances', () => {
  it('never publishes a later message of the same key before an earlier one', async () => {
    const repository = new OutboxRepository(MODULE)
    const transactionManager = new PrismaTransactionManager(prisma())
    const key = 'aggregate-1'

    for (let sequence = 0; sequence < TICKS; sequence += 1) {
      const event = Event.create('test.sequenced', { sequence })
      await transactionManager.execute((tx) => repository.enqueue(event, { key, topic: 'test-topic' }, tx))
      // Guarantees distinct createdAt ordering even at low DB timestamp resolution.
      await sleep(5)
    }

    const producer = new FakeMessageProducer()
    const relayA = new OutboxRelayService(prisma(), producer)
    const relayB = new OutboxRelayService(prisma(), producer)

    /*
     * Two instances racing on the same tick, sharing the DB and the producer: at any moment only
     * the oldest message of this key is eligible, so each tick advances the chain by exactly one.
     */
    for (let tick = 0; tick < TICKS; tick += 1) {
      await Promise.all([relayA.relay(), relayB.relay()])
    }

    const remaining = await prisma().outboxMessage.count({ where: { module: MODULE, status: 'PENDING' } })
    expect(remaining).toBe(0)

    const sequences = producer
      .getPublished()
      .filter((message) => message.key === key)
      .map((message) => (message.message.payload as { sequence: number }).sequence)

    expect(sequences).toEqual([0, 1, 2, 3, 4, 5])
  })
})
