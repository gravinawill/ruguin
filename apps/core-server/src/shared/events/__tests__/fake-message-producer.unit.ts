import { describe, expect, it } from 'vitest'

import { FakeMessageProducer } from '../fake-message-producer'

describe('FakeMessageProducer', () => {
  it('records every published message and always succeeds', async () => {
    const producer = new FakeMessageProducer()

    const result = await producer.publish({
      key: 'service-a',
      message: { eventId: 'event-1', name: 'health.degraded', payload: { reason: 'timeout' } },
      topic: 'health-events'
    })

    expect(result.isSuccess()).toBe(true)
    expect(producer.getPublished()).toEqual([
      {
        key: 'service-a',
        message: { eventId: 'event-1', name: 'health.degraded', payload: { reason: 'timeout' } },
        topic: 'health-events'
      }
    ])
  })

  it('clear() empties the recorded messages', async () => {
    const producer = new FakeMessageProducer()
    await producer.publish({ key: 'k', message: { eventId: 'e', name: 'n', payload: null }, topic: 't' })

    producer.clear()

    expect(producer.getPublished()).toEqual([])
  })
})
