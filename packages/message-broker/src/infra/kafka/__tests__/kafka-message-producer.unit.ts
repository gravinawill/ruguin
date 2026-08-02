import { type Producer } from '@platformatic/kafka'
import { describe, expect, it, vi } from 'vitest'

import { KafkaMessageProducer } from '../kafka-message-producer.ts'

function fakeProducer(send: Producer['send']): Producer {
  return { send } as unknown as Producer
}

describe('KafkaMessageProducer', () => {
  it('publishes the message with the key and headers passed to it', async () => {
    const send = vi.fn().mockResolvedValue({ offsets: [] })
    const producer = new KafkaMessageProducer(fakeProducer(send))

    const result = await producer.publish({
      topic: 'email.send.requested',
      key: 'email-1',
      message: { eventId: 'evt-1', name: 'email.send.requested', payload: { emailId: 'email-1' } },
      headers: { attempt: '1' }
    })

    expect(result.isSuccess()).toBe(true)
    expect(send).toHaveBeenCalledWith({
      messages: [
        {
          topic: 'email.send.requested',
          key: 'email-1',
          value: JSON.stringify({ eventId: 'evt-1', name: 'email.send.requested', payload: { emailId: 'email-1' } }),
          headers: { attempt: '1' }
        }
      ]
    })
  })

  it('returns a MessagePublishError when the underlying send() rejects', async () => {
    const send = vi.fn().mockRejectedValue(new Error('broker unreachable'))
    const producer = new KafkaMessageProducer(fakeProducer(send))

    const result = await producer.publish({
      topic: 'email.send.requested',
      key: 'email-1',
      message: { eventId: 'evt-1', name: 'email.send.requested', payload: {} }
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.name).toBe('MessagePublishError')
    }
  })
})
