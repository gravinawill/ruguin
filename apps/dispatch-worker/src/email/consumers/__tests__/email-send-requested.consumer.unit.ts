import { type MessageConsumerPort, type MessageProducerPort, type SubscribeInput } from '@ruguin/message-broker'
import { success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type SendEmailUseCase } from '../../application/use-cases/send-email.use-case.ts'
import { EmailSendRequestedConsumer, MAIN_CONSUMER_GROUP_ID } from '../email-send-requested.consumer.ts'

describe('EmailSendRequestedConsumer', () => {
  it('subscribes to the main topic under its own consumer group', async () => {
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

    await new EmailSendRequestedConsumer(fakeConsumer, producer, sendEmail).onModuleInit()

    expect(subscribeInput?.topic).toBe('email.send.requested')
    expect(subscribeInput?.groupId).toBe(MAIN_CONSUMER_GROUP_ID)
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

    await new EmailSendRequestedConsumer(fakeConsumer, producer, sendEmail).onModuleInit()

    const result = await onMessage({
      eventId: 'evt-malformed-1',
      name: 'email.send.requested',
      payload: { emailId: 'not-a-uuid' },
      headers: {}
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.isSuccess()).toBe(true)
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'email.send.requested.dlq',
        key: 'evt-malformed-1',
        message: expect.objectContaining({ payload: { emailId: 'not-a-uuid' } })
      })
    )
  })

  it('calls the use case with attempt: 0 for a schema-valid payload', async () => {
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
    const execute = vi.fn().mockResolvedValue(success({ outcome: 'sent' }))
    const sendEmail = { execute } as unknown as SendEmailUseCase

    await new EmailSendRequestedConsumer(fakeConsumer, producer, sendEmail).onModuleInit()

    await onMessage({
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
      headers: {}
    })

    expect(publish).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001', attempt: 0 })
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

    await new EmailSendRequestedConsumer(fakeConsumer, producer, sendEmail).onModuleInit()

    const result = await onMessage({
      eventId: 'evt-2',
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
      headers: {}
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.message).toBe('broker unavailable')
    }
  })
})
