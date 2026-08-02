import { Event } from '@ruguin/ddd-kernel'
import { describe, expect, it } from 'vitest'

import { type TransactionContext } from '../../contracts/transaction-context.contract'
import { EnqueueOutboxMessageError } from '../../errors/enqueue-outbox-message.error'
import { OutboxRepository } from '../outbox.repository'

type CreateArguments = { data: Record<string, unknown> }

function createTransactionStub(createImpl: (arguments_: CreateArguments) => Promise<unknown>): TransactionContext {
  return { outboxMessage: { create: createImpl } } as unknown as TransactionContext
}

describe('OutboxRepository#enqueue', () => {
  it('writes the event through the given transaction, scoped to its module', async () => {
    const calls: CreateArguments[] = []
    const tx = createTransactionStub((arguments_) => {
      calls.push(arguments_)
      return Promise.resolve({ id: 'generated-id', ...arguments_.data })
    })
    const repository = new OutboxRepository('health')
    const event = Event.create('health.degraded', { reason: 'timeout' })

    const result = await repository.enqueue(event, { key: 'service-a', topic: 'health-events' }, tx)

    expect(result.isSuccess()).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.data).toMatchObject({
      eventId: event.id.toString(),
      key: 'service-a',
      module: 'health',
      name: 'health.degraded',
      payload: { reason: 'timeout' },
      topic: 'health-events'
    })
  })

  it('maps any thrown error during create into EnqueueOutboxMessageError', async () => {
    const tx = createTransactionStub(() => {
      throw new Error('connection terminated unexpectedly')
    })
    const repository = new OutboxRepository('health')
    const event = Event.create('health.degraded', { reason: 'timeout' })

    const result = await repository.enqueue(event, { key: 'service-a', topic: 'health-events' }, tx)

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(EnqueueOutboxMessageError)
  })
})
