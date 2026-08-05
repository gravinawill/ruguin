import { EMAIL_STATUS_UPDATED_DLQ_TOPIC, EMAIL_STATUS_UPDATED_TOPIC } from '@ruguin/event-schemas'
import { type MessageConsumerPort, type MessageProducerPort, type SubscribeInput } from '@ruguin/message-broker'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type RecordSentCorrelationUseCase } from '../../application/use-cases/record-sent-correlation.use-case.ts'
import { CORRELATION_CONSUMER_GROUP_ID, EmailStatusUpdatedSentConsumer } from '../email-status-updated-sent.consumer.ts'

const VALID_EMAIL_ID = '018f9a9e-6f0a-7c3e-9b0a-000000000001'

describe('EmailStatusUpdatedSentConsumer', () => {
  it('subscribes to the email.status.updated topic under its own consumer group', async () => {
    let subscribeInput: SubscribeInput | undefined
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput) => {
        subscribeInput = input
        return success(undefined)
      })
    }
    const producer = { publish: vi.fn() } as unknown as MessageProducerPort
    const recordSentCorrelation = { execute: vi.fn() } as unknown as RecordSentCorrelationUseCase

    await new EmailStatusUpdatedSentConsumer(fakeConsumer, producer, recordSentCorrelation).onModuleInit()

    expect(subscribeInput?.topic).toBe(EMAIL_STATUS_UPDATED_TOPIC)
    expect(subscribeInput?.groupId).toBe(CORRELATION_CONSUMER_GROUP_ID)
  })

  it('routes a schema-invalid payload to the DLQ instead of dropping it', async () => {
    let onMessage!: SubscribeInput['onMessage']
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput) => {
        onMessage = input.onMessage
        return success(undefined)
      })
    }
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const producer = { publish } as unknown as MessageProducerPort
    const execute = vi.fn()
    const recordSentCorrelation = { execute } as unknown as RecordSentCorrelationUseCase

    await new EmailStatusUpdatedSentConsumer(fakeConsumer, producer, recordSentCorrelation).onModuleInit()

    const result = await onMessage({
      eventId: 'evt-malformed-1',
      name: 'email.status.updated',
      payload: { emailId: 'not-a-uuid' },
      headers: { 'x-trace': 'abc' }
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.isSuccess()).toBe(true)
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EMAIL_STATUS_UPDATED_DLQ_TOPIC,
        key: 'evt-malformed-1',
        message: expect.objectContaining({ payload: { emailId: 'not-a-uuid' } }),
        headers: { 'x-trace': 'abc' }
      })
    )
  })

  it('skips a schema-valid payload whose status is not "sent"', async () => {
    let onMessage!: SubscribeInput['onMessage']
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput) => {
        onMessage = input.onMessage
        return success(undefined)
      })
    }
    const publish = vi.fn()
    const producer = { publish } as unknown as MessageProducerPort
    const execute = vi.fn()
    const recordSentCorrelation = { execute } as unknown as RecordSentCorrelationUseCase

    await new EmailStatusUpdatedSentConsumer(fakeConsumer, producer, recordSentCorrelation).onModuleInit()

    const result = await onMessage({
      eventId: 'evt-delivered-1',
      name: 'email.status.updated',
      payload: { emailId: VALID_EMAIL_ID, status: 'delivered' },
      headers: {}
    })

    expect(execute).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(result.isSuccess()).toBe(true)
  })

  it('skips a schema-valid status=sent payload that has no sesMessageId', async () => {
    let onMessage!: SubscribeInput['onMessage']
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput) => {
        onMessage = input.onMessage
        return success(undefined)
      })
    }
    const publish = vi.fn()
    const producer = { publish } as unknown as MessageProducerPort
    const execute = vi.fn()
    const recordSentCorrelation = { execute } as unknown as RecordSentCorrelationUseCase

    await new EmailStatusUpdatedSentConsumer(fakeConsumer, producer, recordSentCorrelation).onModuleInit()

    const result = await onMessage({
      eventId: 'evt-sent-no-ses-id',
      name: 'email.status.updated',
      payload: { emailId: VALID_EMAIL_ID, status: 'sent' },
      headers: {}
    })

    expect(execute).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(result.isSuccess()).toBe(true)
  })

  it('records the correlation for a status=sent payload carrying a sesMessageId', async () => {
    let onMessage!: SubscribeInput['onMessage']
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput) => {
        onMessage = input.onMessage
        return success(undefined)
      })
    }
    const publish = vi.fn()
    const producer = { publish } as unknown as MessageProducerPort
    const execute = vi.fn().mockResolvedValue(success(undefined))
    const recordSentCorrelation = { execute } as unknown as RecordSentCorrelationUseCase

    await new EmailStatusUpdatedSentConsumer(fakeConsumer, producer, recordSentCorrelation).onModuleInit()

    const result = await onMessage({
      eventId: 'evt-sent-1',
      name: 'email.status.updated',
      payload: { emailId: VALID_EMAIL_ID, status: 'sent', sesMessageId: 'ses-msg-1' },
      headers: {}
    })

    expect(publish).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledWith({ sesMessageId: 'ses-msg-1', emailId: VALID_EMAIL_ID })
    expect(result.isSuccess()).toBe(true)
  })

  it('returns a failure when recording the correlation fails, so KafkaMessageConsumer does not commit the offset', async () => {
    let onMessage!: SubscribeInput['onMessage']
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput) => {
        onMessage = input.onMessage
        return success(undefined)
      })
    }
    const producer = { publish: vi.fn() } as unknown as MessageProducerPort
    const correlationError = { name: 'CorrelationUpsertError', message: 'db down' }
    const execute = vi.fn().mockResolvedValue(failure(correlationError))
    const recordSentCorrelation = { execute } as unknown as RecordSentCorrelationUseCase

    await new EmailStatusUpdatedSentConsumer(fakeConsumer, producer, recordSentCorrelation).onModuleInit()

    const result = await onMessage({
      eventId: 'evt-sent-2',
      name: 'email.status.updated',
      payload: { emailId: VALID_EMAIL_ID, status: 'sent', sesMessageId: 'ses-msg-2' },
      headers: {}
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(correlationError)
  })
})
