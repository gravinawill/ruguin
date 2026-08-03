import { Test } from '@nestjs/testing'
import { success } from '@ruguin/utils'
import { describe, expect, it } from 'vitest'

import { MESSAGE_CONSUMER_PORT, type MessageConsumerPort } from '../../domain/contracts/message-consumer.port.ts'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '../../domain/contracts/message-producer.port.ts'
import { MessageBrokerModule } from '../message-broker.module.ts'

const TEST_TOPIC = 'message-broker-integration-test'

describe('MessageBrokerModule (real Kafka)', () => {
  it('round-trips a published message back through the consumer', async () => {
    const moduleReference = await Test.createTestingModule({
      imports: [
        MessageBrokerModule.forRoot({
          brokers: ['localhost:9092'],
          clientId: 'message-broker-int-test',
          // The test topic doesn't pre-exist on a clean broker; auto-create it on first publish/subscribe.
          autoCreateTopics: true
        })
      ]
    }).compile()

    const producer = moduleReference.get<MessageProducerPort>(MESSAGE_PRODUCER_PORT)
    const consumer = moduleReference.get<MessageConsumerPort>(MESSAGE_CONSUMER_PORT)

    const received: unknown[] = []

    await consumer.subscribe({
      topic: TEST_TOPIC,
      groupId: `message-broker-int-test-${Date.now()}`,
      onMessage: (message) => {
        received.push(message)
        return Promise.resolve(success(undefined))
      }
    })

    await producer.publish({
      topic: TEST_TOPIC,
      key: 'round-trip',
      message: { eventId: 'evt-1', name: 'test.roundtrip', payload: { ok: true } }
    })

    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (received.length === 0) return

        clearInterval(interval)
        resolve(undefined)
      }, 200)
    })

    expect(received[0]).toMatchObject({ eventId: 'evt-1', name: 'test.roundtrip', payload: { ok: true } })

    await moduleReference.close()
  }, 20_000)
})
