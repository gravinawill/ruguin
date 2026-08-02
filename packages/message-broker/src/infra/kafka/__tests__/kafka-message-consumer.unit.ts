import { type Consumer } from '@platformatic/kafka'
import { success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { KafkaMessageConsumer } from '../kafka-message-consumer.ts'

type StringConsumer = Consumer<string, string, string, string>
type FakeStreamMessage = { value: string; headers: Map<string, string> }

function fakeStream(messages: FakeStreamMessage[]): AsyncIterable<FakeStreamMessage> {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- async generator required to satisfy AsyncIterable; no await needed to yield the fixed fixture messages
    [Symbol.asyncIterator]: async function* () {
      for (const message of messages) yield message
    }
  }
}

function fakeConsumer(consume: StringConsumer['consume']): StringConsumer {
  return { consume } as unknown as StringConsumer
}

describe('KafkaMessageConsumer', () => {
  it('builds a consumer for the given groupId, consumes the topic, and forwards each message as InboundMessage', async () => {
    const stream = fakeStream([
      {
        value: JSON.stringify({ eventId: 'evt-1', name: 'email.send.requested', payload: { emailId: 'e1' } }),
        headers: new Map([['attempt', '1']])
      }
    ])
    const consume = vi.fn().mockResolvedValue(stream)
    const createConsumer = vi.fn().mockReturnValue(fakeConsumer(consume))

    const onMessage = vi.fn().mockResolvedValue(success(undefined))
    const kafkaConsumer = new KafkaMessageConsumer(createConsumer)

    const result = await kafkaConsumer.subscribe({
      topic: 'email.send.requested',
      groupId: 'dispatch-worker',
      onMessage
    })

    expect(result.isSuccess()).toBe(true)
    expect(createConsumer).toHaveBeenCalledWith('dispatch-worker')
    expect(consume).toHaveBeenCalledWith({ topics: ['email.send.requested'] })

    // Message forwarding runs on a detached loop — give it a tick to process the fake stream.
    await new Promise((resolve) => setImmediate(resolve))

    expect(onMessage).toHaveBeenCalledWith({
      eventId: 'evt-1',
      name: 'email.send.requested',
      payload: { emailId: 'e1' },
      headers: { attempt: '1' }
    })
  })

  it('returns a MessageConsumeError when consume() rejects', async () => {
    const consume = vi.fn().mockRejectedValue(new Error('unreachable'))
    const createConsumer = vi.fn().mockReturnValue(fakeConsumer(consume))

    const result = await new KafkaMessageConsumer(createConsumer).subscribe({
      topic: 'email.send.requested',
      groupId: 'dispatch-worker',
      onMessage: vi.fn()
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.name).toBe('MessageConsumeError')
    }
  })

  it('does not stop consuming after a message with malformed JSON', async () => {
    const stream = fakeStream([
      { value: 'not valid json', headers: new Map() },
      {
        value: JSON.stringify({ eventId: 'evt-2', name: 'email.send.requested', payload: { emailId: 'e2' } }),
        headers: new Map()
      }
    ])
    const consume = vi.fn().mockResolvedValue(stream)
    const createConsumer = vi.fn().mockReturnValue(fakeConsumer(consume))

    const onMessage = vi.fn().mockResolvedValue(success(undefined))
    await new KafkaMessageConsumer(createConsumer).subscribe({
      topic: 'email.send.requested',
      groupId: 'dispatch-worker',
      onMessage
    })

    // Message forwarding runs on a detached loop — give it a tick to process the fake stream.
    await new Promise((resolve) => setImmediate(resolve))

    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt-2' }))
  })
})
