import { type MessageConsumerPort, type MessageProducerPort, type SubscribeInput } from '@ruguin/message-broker'
import { success } from '@ruguin/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type SendEmailUseCase } from '../../application/use-cases/send-email.use-case.ts'
import { EmailSendRequestedRetryConsumer, RETRY_CONSUMER_GROUP_ID } from '../email-send-requested-retry.consumer.ts'

describe('EmailSendRequestedRetryConsumer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes to the retry topic under its own consumer group', async () => {
    let subscribeInput: SubscribeInput | undefined
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput) => {
        subscribeInput = input
        return success(undefined)
      })
    }
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const producer = { publish } as unknown as MessageProducerPort
    const execute = vi.fn().mockResolvedValue(success({ outcome: 'sent' }))
    const sendEmail = { execute } as unknown as SendEmailUseCase

    await new EmailSendRequestedRetryConsumer(fakeConsumer, producer, sendEmail).onModuleInit()

    expect(subscribeInput?.topic).toBe('email.send.requested.retry')
    expect(subscribeInput?.groupId).toBe(RETRY_CONSUMER_GROUP_ID)
  })

  it('waits until nextAttemptAt before calling the use case, then passes the header attempt through', async () => {
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
    const execute = vi.fn().mockResolvedValue(success({ outcome: 'sent' }))
    const sendEmail = { execute } as unknown as SendEmailUseCase

    await new EmailSendRequestedRetryConsumer(fakeConsumer, producer, sendEmail).onModuleInit()

    /*
     * emailId/organizationId/projectId must be real UUIDs — the consumer runs this payload through
     * EmailSendRequestedPayloadSchema.safeParse() for real; a schema-invalid payload here would be
     * routed to the DLQ without ever calling sendEmail.execute, and this test's assertion would
     * fail with a confusing "not called" instead of a clear parse-failure signal.
     */
    const messagePromise = onMessage({
      eventId: 'evt-1',
      name: 'email.send.requested',
      payload: {
        emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
        organizationId: '018f9a9e-6f0a-7c3e-9b0a-000000000002',
        projectId: '018f9a9e-6f0a-7c3e-9b0a-000000000003',
        from: 'a@ruguin.dev',
        to: 'b@ruguin.dev',
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi'
      },
      headers: { attempt: '1', nextAttemptAt: '2026-08-02T12:00:10.000Z' }
    })

    await vi.advanceTimersByTimeAsync(10_000)
    await messagePromise

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001', attempt: 1 })
    )
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
    const sendEmail = { execute } as unknown as SendEmailUseCase

    await new EmailSendRequestedRetryConsumer(fakeConsumer, producer, sendEmail).onModuleInit()

    const result = await onMessage({
      eventId: 'evt-malformed-retry-1',
      name: 'email.send.requested',
      payload: { emailId: 'not-a-uuid' },
      headers: {}
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.isSuccess()).toBe(true)
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'email.send.requested.dlq', key: 'evt-malformed-retry-1' })
    )
  })

  it('routes to the DLQ instead of retry-looping forever when the attempt header is not a number', async () => {
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
    const sendEmail = { execute } as unknown as SendEmailUseCase

    await new EmailSendRequestedRetryConsumer(fakeConsumer, producer, sendEmail).onModuleInit()

    const result = await onMessage({
      eventId: 'evt-bad-header-1',
      name: 'email.send.requested',
      payload: {
        emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
        organizationId: '018f9a9e-6f0a-7c3e-9b0a-000000000002',
        projectId: '018f9a9e-6f0a-7c3e-9b0a-000000000003',
        from: 'a@ruguin.dev',
        to: 'b@ruguin.dev',
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi'
      },
      headers: { attempt: 'not-a-number', nextAttemptAt: '2026-08-02T12:00:10.000Z' }
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.isSuccess()).toBe(true)
    /*
     * The malformed attempt/nextAttemptAt values only exist in the headers, not the payload — the
     * DLQ publish must forward the original headers, or that diagnostic is lost once the message
     * reaches the DLQ.
     */
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'email.send.requested.dlq',
        key: 'evt-bad-header-1',
        headers: { attempt: 'not-a-number', nextAttemptAt: '2026-08-02T12:00:10.000Z' }
      })
    )
  })

  it('routes to the DLQ when the nextAttemptAt header is not a parseable date', async () => {
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
    const sendEmail = { execute } as unknown as SendEmailUseCase

    await new EmailSendRequestedRetryConsumer(fakeConsumer, producer, sendEmail).onModuleInit()

    const result = await onMessage({
      eventId: 'evt-bad-header-2',
      name: 'email.send.requested',
      payload: {
        emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
        organizationId: '018f9a9e-6f0a-7c3e-9b0a-000000000002',
        projectId: '018f9a9e-6f0a-7c3e-9b0a-000000000003',
        from: 'a@ruguin.dev',
        to: 'b@ruguin.dev',
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi'
      },
      headers: { attempt: '1', nextAttemptAt: 'not-a-date' }
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.isSuccess()).toBe(true)
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'email.send.requested.dlq', key: 'evt-bad-header-2' })
    )
  })

  it('returns a failure when the use case fails, so KafkaMessageConsumer does not commit the offset', async () => {
    let onMessage!: SubscribeInput['onMessage']
    const fakeConsumer: MessageConsumerPort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async is required by interface contract
      subscribe: vi.fn().mockImplementation(async (input: SubscribeInput) => {
        onMessage = input.onMessage
        return success(undefined)
      })
    }
    const producer = { publish: vi.fn() } as unknown as MessageProducerPort
    const execute = vi
      .fn()
      .mockResolvedValue({ isFailure: () => true, isSuccess: () => false, value: { message: 'broker unavailable' } })
    const sendEmail = { execute } as unknown as SendEmailUseCase

    await new EmailSendRequestedRetryConsumer(fakeConsumer, producer, sendEmail).onModuleInit()

    const messagePromise = onMessage({
      eventId: 'evt-7',
      name: 'email.send.requested',
      payload: {
        emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
        organizationId: '018f9a9e-6f0a-7c3e-9b0a-000000000002',
        projectId: '018f9a9e-6f0a-7c3e-9b0a-000000000003',
        from: 'a@ruguin.dev',
        to: 'b@ruguin.dev',
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi'
      },
      headers: { attempt: '1', nextAttemptAt: '2026-08-02T12:00:10.000Z' }
    })

    await vi.advanceTimersByTimeAsync(10_000)
    const result = await messagePromise

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.message).toBe('broker unavailable')
    }
  })
})
