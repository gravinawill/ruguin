import { type Consumer } from '@platformatic/kafka'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { MessageConsumeError } from '../../../domain/errors/message-consume.error.ts'
import { KafkaMessageConsumer } from '../kafka-message-consumer.ts'

type StringConsumer = Consumer<string, string, string, string>
type FakeStreamMessage = { value: string; headers: Map<string, string>; commit: () => Promise<void> }

function fakeStream(messages: FakeStreamMessage[]): AsyncIterable<FakeStreamMessage> {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- async generator required to satisfy AsyncIterable; no await needed to yield the fixed fixture messages
    [Symbol.asyncIterator]: async function* () {
      for (const message of messages) yield message
    }
  }
}

function fakeMessage(value: string, headers = new Map<string, string>()): FakeStreamMessage {
  return { value, headers, commit: vi.fn().mockResolvedValue(undefined) }
}

function fakeConsumer(consume: StringConsumer['consume']): StringConsumer {
  return { consume } as unknown as StringConsumer
}

describe('KafkaMessageConsumer', () => {
  it('builds a consumer for the given groupId, consumes the topic, and forwards each message as InboundMessage', async () => {
    const message = fakeMessage(
      JSON.stringify({ eventId: 'evt-1', name: 'email.send.requested', payload: { emailId: 'e1' } }),
      new Map([['attempt', '1']])
    )
    const stream = fakeStream([message])
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
      fakeMessage('not valid json'),
      fakeMessage(JSON.stringify({ eventId: 'evt-2', name: 'email.send.requested', payload: { emailId: 'e2' } }))
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

  it('commits the message only after onMessage resolves successfully (at-least-once delivery)', async () => {
    const message = fakeMessage(
      JSON.stringify({ eventId: 'evt-3', name: 'email.send.requested', payload: { emailId: 'e3' } })
    )
    const stream = fakeStream([message])
    const consume = vi.fn().mockResolvedValue(stream)
    const createConsumer = vi.fn().mockReturnValue(fakeConsumer(consume))

    const onMessage = vi.fn().mockResolvedValue(success(undefined))
    await new KafkaMessageConsumer(createConsumer).subscribe({
      topic: 'email.send.requested',
      groupId: 'dispatch-worker',
      onMessage
    })

    await new Promise((resolve) => setImmediate(resolve))

    expect(message.commit).toHaveBeenCalledOnce()
  })

  it('does not commit the message when onMessage resolves with a failure', async () => {
    const message = fakeMessage(
      JSON.stringify({ eventId: 'evt-4', name: 'email.send.requested', payload: { emailId: 'e4' } })
    )
    const stream = fakeStream([message])
    const consume = vi.fn().mockResolvedValue(stream)
    const createConsumer = vi.fn().mockReturnValue(fakeConsumer(consume))

    const onMessage = vi.fn().mockResolvedValue(failure(new MessageConsumeError({ message: 'boom' })))
    await new KafkaMessageConsumer(createConsumer).subscribe({
      topic: 'email.send.requested',
      groupId: 'dispatch-worker',
      onMessage
    })

    await new Promise((resolve) => setImmediate(resolve))

    expect(message.commit).not.toHaveBeenCalled()
  })

  it('does not commit a message whose JSON is malformed (onMessage never runs)', async () => {
    const message = fakeMessage('not valid json')
    const stream = fakeStream([message])
    const consume = vi.fn().mockResolvedValue(stream)
    const createConsumer = vi.fn().mockReturnValue(fakeConsumer(consume))

    await new KafkaMessageConsumer(createConsumer).subscribe({
      topic: 'email.send.requested',
      groupId: 'dispatch-worker',
      onMessage: vi.fn()
    })

    await new Promise((resolve) => setImmediate(resolve))

    expect(message.commit).not.toHaveBeenCalled()
  })

  it('closes every consumer it created, on module destroy', async () => {
    // close(force, callback) — the real client is callback-style; it never returns a Promise directly.
    const closeA = vi.fn((isForced: boolean, callback: (error: Error | null) => void) => {
      if (isForced) callback(null)
    })
    const closeB = vi.fn((isForced: boolean, callback: (error: Error | null) => void) => {
      if (isForced) callback(null)
    })
    const consumeA = vi.fn().mockResolvedValue(fakeStream([]))
    const consumeB = vi.fn().mockResolvedValue(fakeStream([]))
    const createConsumer = vi
      .fn()
      .mockReturnValueOnce({ consume: consumeA, close: closeA })
      .mockReturnValueOnce({ consume: consumeB, close: closeB })

    const kafkaConsumer = new KafkaMessageConsumer(createConsumer)
    await kafkaConsumer.subscribe({ topic: 'email.send.requested', groupId: 'dispatch-worker', onMessage: vi.fn() })
    await kafkaConsumer.subscribe({
      topic: 'email.send.requested.retry',
      groupId: 'dispatch-worker-retry',
      onMessage: vi.fn()
    })

    await kafkaConsumer.onModuleDestroy()

    /*
     * force: true — a stream is still open on each consumer (subscribe() never awaits it draining),
     * and @platformatic/kafka's close(false) refuses to leave the group while one is open.
     */
    expect(closeA).toHaveBeenCalledWith(true, expect.any(Function))
    expect(closeB).toHaveBeenCalledWith(true, expect.any(Function))
  })
})
