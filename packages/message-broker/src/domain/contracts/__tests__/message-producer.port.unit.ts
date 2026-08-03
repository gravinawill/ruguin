import { success } from '@ruguin/utils'
import { describe, expect, it } from 'vitest'

import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '../message-producer.port.ts'

describe('MessageProducerPort', () => {
  it('is implementable with the expected publish() shape', async () => {
    const producer: MessageProducerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      publish: async (input) => {
        expect(input.topic).toBe('email.send.requested')
        return success(undefined)
      }
    }

    const result = await producer.publish({
      topic: 'email.send.requested',
      key: 'email-1',
      message: { eventId: 'evt-1', name: 'email.send.requested', payload: { emailId: 'email-1' } }
    })

    expect(result.isSuccess()).toBe(true)
  })

  it('exposes a distinct DI token', () => {
    expect(typeof MESSAGE_PRODUCER_PORT).toBe('symbol')
  })
})
