import { BaseError, Event, StatusError } from '@ruguin/shared-domain'
import { type Either, failure } from '@ruguin/utils'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { type MessageProducerPort, type OutboundMessage } from '../../../domain/contracts/message-producer.port'
import { type PrismaService } from '../../database/prisma/prisma.service'
import { PrismaTransactionManager } from '../../database/prisma/prisma-transaction-manager'
import { FakeMessageProducer } from '../../events/fake-message-producer'
import { OutboxRepository } from '../outbox.repository'
import { OutboxRelayService } from '../outbox-relay.service'

import { createTestPrismaService, relayUntil, sleep } from './outbox-test-context'

class FlakyPublishError extends BaseError {
  readonly name = 'FlakyPublishError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor() {
    super({ message: 'simulated transient publish failure' })
  }
}

/*
 * Fails exactly once for the given sequence number, then delegates every other call (including the
 * retry of that same message) to a real FakeMessageProducer — local to this test, not a change to
 * the shared fake.
 */
class FlakyOnceProducer implements MessageProducerPort {
  private hasFailed = false

  constructor(
    private readonly inner: FakeMessageProducer,
    private readonly failForSequence: number
  ) {}

  public async publish(input: OutboundMessage): Promise<Either<BaseError, void>> {
    const sequence = (input.message.payload as { sequence: number }).sequence

    if (sequence === this.failForSequence && !this.hasFailed) {
      this.hasFailed = true
      return failure(new FlakyPublishError())
    }

    return this.inner.publish(input)
  }
}

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

  it('never publishes a later message of the same key before an earlier one that is still retrying', async () => {
    const repository = new OutboxRepository(MODULE)
    const transactionManager = new PrismaTransactionManager(prisma())
    const key = 'aggregate-retry'

    for (let sequence = 0; sequence < 2; sequence += 1) {
      const event = Event.create('test.sequenced', { sequence })
      await transactionManager.execute((tx) => repository.enqueue(event, { key, topic: 'test-topic' }, tx))
      await sleep(5)
    }

    const fake = new FakeMessageProducer()
    const producer = new FlakyOnceProducer(fake, 0)
    const relay = new OutboxRelayService(prisma(), producer)

    /*
     * First tick: message 0 (the only rn=1 candidate) is picked, publish fails, attempts/nextAttemptAt
     * are set. A second immediate tick must yield nothing — message 0 is still the only eligible
     * (module, key) candidate and it is not due yet, so message 1 must not be picked in its place.
     */
    await relay.relay()
    await relay.relay()

    const publishedBeforeBackoffElapses = fake.getPublished().filter((message) => message.key === key)
    expect(publishedBeforeBackoffElapses).toHaveLength(0)

    /*
     * Polls the relay until the backoff elapses and both messages drain, instead of sleeping past
     * a hand-computed margin between the app clock (writes nextAttemptAt) and Postgres's now().
     */
    await relayUntil(
      relay,
      async () => (await prisma().outboxMessage.count({ where: { module: MODULE, status: 'PENDING' } })) === 0
    )

    const sequences = fake
      .getPublished()
      .filter((message) => message.key === key)
      .map((message) => (message.message.payload as { sequence: number }).sequence)

    expect(sequences).toEqual([0, 1])
  })

  it('never publishes a later message of the same key before an earlier one sharing its createdAt', async () => {
    const key = 'aggregate-same-timestamp'

    /*
     * Two messages that share a createdAt to the millisecond. This is not contrived: createdAt is
     * TIMESTAMP(3) and Prisma stamps @default(now()) client-side per insert, so a use case that
     * enqueues several events in one transaction collides constantly — measured at 13-16 collisions
     * per 40 consecutive enqueues. Writing the timestamp explicitly just makes the collision
     * deterministic instead of leaving it to how fast the machine ran.
     *
     * Enqueueing directly rather than through OutboxRepository is deliberate for the same reason:
     * the repository cannot be made to produce a guaranteed tie. id still comes from the schema's
     * own @default(uuid(7)), so the tiebreak under test is exactly the production one.
     */
    const sharedCreatedAt = new Date()
    for (let sequence = 0; sequence < 2; sequence += 1) {
      await prisma().outboxMessage.create({
        data: {
          createdAt: sharedCreatedAt,
          eventId: Event.create('test.sequenced', { sequence }).id.toString(),
          key,
          module: MODULE,
          name: 'test.sequenced',
          payload: { sequence },
          topic: 'test-topic'
        }
      })
    }

    const fake = new FakeMessageProducer()
    const producer = new FlakyOnceProducer(fake, 0)
    const relay = new OutboxRelayService(prisma(), producer)

    /*
     * The single transient failure is what makes the tie observable: marking sequence 0 as retrying
     * UPDATEs it, and Postgres MVCC writes the new row version at the end of the heap — physically
     * after sequence 1. The relay ranks over a Seq Scan feeding a Sort, so with createdAt alone the
     * next tick ranks sequence 1 first and publishes it ahead of sequence 0. Ranking has to survive
     * that reordering, which is what the id tiebreak buys.
     */
    await relay.relay()
    await relay.relay()

    const publishedBeforeBackoffElapses = fake.getPublished().filter((message) => message.key === key)
    expect(publishedBeforeBackoffElapses).toHaveLength(0)

    await relayUntil(
      relay,
      async () => (await prisma().outboxMessage.count({ where: { module: MODULE, status: 'PENDING' } })) === 0
    )

    const sequences = fake
      .getPublished()
      .filter((message) => message.key === key)
      .map((message) => (message.message.payload as { sequence: number }).sequence)

    expect(sequences).toEqual([0, 1])
  })
})
