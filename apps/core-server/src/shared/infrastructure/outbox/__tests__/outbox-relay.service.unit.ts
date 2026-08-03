import { BaseError, StatusError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type MessageProducerPort } from '../../../domain/contracts/message-producer.port'
import { type PrismaService } from '../../database/prisma/prisma.service'
import { OutboxRelayService } from '../outbox-relay.service'

class SamplePublishError extends BaseError {
  readonly name = 'SamplePublishError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor() {
    super({ message: 'broker unavailable' })
  }
}

type Row = {
  id: string
  createdAt: Date
  eventId: string
  module: string
  topic: string
  key: string
  name: string
  payload: unknown
  attempts: number
}

function createRow(overrides: Partial<Row> = {}): Row {
  return {
    attempts: 0,
    createdAt: new Date('2026-08-02T00:00:00.000Z'),
    eventId: 'event-1',
    id: 'row-1',
    key: 'service-a',
    module: 'health',
    name: 'health.degraded',
    payload: { reason: 'timeout' },
    topic: 'health-events',
    ...overrides
  }
}

function createPrismaStub(rows: Row[]): {
  prisma: PrismaService
  updates: Array<{ where: unknown; data: unknown }>
  queries: string[]
} {
  const updates: Array<{ where: unknown; data: unknown }> = []
  const queries: string[] = []

  const tx = {
    // eslint-disable-next-line @typescript-eslint/require-await -- Satisfies async $queryRaw contract; stub has nothing to await
    $queryRaw: async (strings: TemplateStringsArray) => {
      queries.push(strings.join(' '))
      return rows
    },
    outboxMessage: {
      // eslint-disable-next-line @typescript-eslint/require-await -- Satisfies async update contract; stub has nothing to await
      update: async (arguments_: { where: unknown; data: unknown }) => {
        updates.push(arguments_)
        return arguments_
      }
    }
  }

  const prisma = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(tx),
    schema: 'core_server'
  } as unknown as PrismaService

  return { prisma, updates, queries }
}

describe('OutboxRelayService#relay', () => {
  it('publishes each eligible row and marks it PUBLISHED', async () => {
    const row = createRow()
    const { prisma, updates } = createPrismaStub([row])
    // eslint-disable-next-line @typescript-eslint/require-await -- Satisfies async publish contract; stub has nothing to await
    const publish = vi.fn(async (): Promise<Either<SamplePublishError, void>> => success(undefined))
    const messageProducer: MessageProducerPort = { publish }

    const relay = new OutboxRelayService(prisma, messageProducer)
    await relay.relay()

    expect(publish).toHaveBeenCalledWith({
      key: 'service-a',
      message: { eventId: 'event-1', name: 'health.degraded', payload: { reason: 'timeout' } },
      topic: 'health-events'
    })
    expect(updates).toHaveLength(1)
    expect(updates[0]?.data).toMatchObject({ status: 'PUBLISHED' })
  })

  it('increments attempts and schedules a retry when publish fails below the max attempts', async () => {
    const row = createRow({ attempts: 1 })
    const { prisma, updates } = createPrismaStub([row])
    const messageProducer: MessageProducerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Satisfies async publish contract; stub has nothing to await
      publish: vi.fn(async (): Promise<Either<SamplePublishError, void>> => failure(new SamplePublishError()))
    }

    const relay = new OutboxRelayService(prisma, messageProducer)
    await relay.relay()

    expect(updates[0]?.data).toMatchObject({ attempts: 2 })
    expect((updates[0]?.data as { nextAttemptAt: Date }).nextAttemptAt).toBeInstanceOf(Date)
    expect((updates[0]?.data as { status?: unknown }).status).toBeUndefined()
  })

  it('moves the row to FAILED once it reaches the max attempts', async () => {
    const row = createRow({ attempts: 4 })
    const { prisma, updates } = createPrismaStub([row])
    const messageProducer: MessageProducerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Satisfies async publish contract; stub has nothing to await
      publish: vi.fn(async (): Promise<Either<SamplePublishError, void>> => failure(new SamplePublishError()))
    }

    const relay = new OutboxRelayService(prisma, messageProducer)
    await relay.relay()

    expect(updates[0]?.data).toMatchObject({ attempts: 5, status: 'FAILED' })
  })

  it('does nothing when there are no eligible rows', async () => {
    const { prisma, updates } = createPrismaStub([])
    const publish = vi.fn()
    const messageProducer: MessageProducerPort = { publish }

    const relay = new OutboxRelayService(prisma, messageProducer)
    await relay.relay()

    expect(publish).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('treats a rejected publish() the same as a returned failure, persisting attempts and nextAttemptAt', async () => {
    const row = createRow({ attempts: 1 })
    const { prisma, updates } = createPrismaStub([row])
    const messageProducer: MessageProducerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Satisfies async publish contract; this stub rejects instead of awaiting
      publish: vi.fn(async (): Promise<Either<SamplePublishError, void>> => {
        throw new Error('broker client crashed')
      })
    }

    const relay = new OutboxRelayService(prisma, messageProducer)
    await relay.relay()

    expect(updates).toHaveLength(1)
    expect(updates[0]?.data).toMatchObject({ attempts: 2, lastError: 'broker client crashed' })
    expect((updates[0]?.data as { nextAttemptAt: Date }).nextAttemptAt).toBeInstanceOf(Date)
    expect((updates[0]?.data as { status?: unknown }).status).toBeUndefined()
  })

  it('extracts a message even when publish() rejects with a non-Error value', async () => {
    const row = createRow({ attempts: 1 })
    const { prisma, updates } = createPrismaStub([row])
    const messageProducer: MessageProducerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Satisfies async publish contract; this stub rejects instead of awaiting
      publish: vi.fn(async (): Promise<Either<SamplePublishError, void>> => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercising a broker client that rejects with a non-Error value
        throw 'ECONNRESET'
      })
    }

    const relay = new OutboxRelayService(prisma, messageProducer)
    await relay.relay()

    expect(updates[0]?.data).toMatchObject({ lastError: 'ECONNRESET' })
  })

  it('swallows a whole-transaction failure so one bad @Interval tick cannot crash the scheduler, and clears the running guard for the next tick', async () => {
    let transactionAttempts = 0
    const prisma = {
      $transaction: () => {
        transactionAttempts += 1
        return Promise.reject(new Error('deadlock detected'))
      },
      schema: 'core_server'
    } as unknown as PrismaService
    const publish = vi.fn()
    const relay = new OutboxRelayService(prisma, { publish })

    await expect(relay.relay()).resolves.toBeUndefined()
    await expect(relay.relay()).resolves.toBeUndefined()

    expect(transactionAttempts).toBe(2)
    expect(publish).not.toHaveBeenCalled()
  })

  it('swallows a whole-transaction failure even when it rejects with a non-Error value', async () => {
    const prisma = {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercising a rejection reason that isn't an Error, on purpose
      $transaction: () => Promise.reject('connection pool exhausted'),
      schema: 'core_server'
    } as unknown as PrismaService
    const messageProducer: MessageProducerPort = { publish: vi.fn() }
    const relay = new OutboxRelayService(prisma, messageProducer)

    await expect(relay.relay()).resolves.toBeUndefined()
  })

  it('skips a tick entirely while the previous one is still running, instead of starting a second transaction on top of it', async () => {
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void>() is the documented signature for a promise with no resolved value
    const firstTransaction = Promise.withResolvers<void>()
    let transactionStarts = 0
    const prisma = {
      $transaction: () => {
        transactionStarts += 1
        return firstTransaction.promise
      },
      schema: 'core_server'
    } as unknown as PrismaService
    const messageProducer: MessageProducerPort = { publish: vi.fn() }
    const relay = new OutboxRelayService(prisma, messageProducer)

    const firstTick = relay.relay()
    await relay.relay()

    expect(transactionStarts).toBe(1)

    firstTransaction.resolve()
    await firstTick
  })
})
