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

  it('caps what it retains, dropping the oldest, so a long-running process cannot grow without bound', async () => {
    const producer = new FakeMessageProducer()
    const overflow = 3

    for (let index = 0; index < 10_000 + overflow; index += 1) {
      await producer.publish({
        key: 'k',
        message: { eventId: `event-${index}`, name: 'n', payload: { index } },
        topic: 't'
      })
    }

    const published = producer.getPublished()
    expect(published).toHaveLength(10_000)
    expect(published[0]?.message.eventId).toBe(`event-${overflow}`)
    expect(published.at(-1)?.message.eventId).toBe(`event-${10_000 + overflow - 1}`)
  })

  it('clear() empties the recorded messages', async () => {
    const producer = new FakeMessageProducer()
    await producer.publish({ key: 'k', message: { eventId: 'e', name: 'n', payload: null }, topic: 't' })

    producer.clear()

    expect(producer.getPublished()).toEqual([])
  })
})
