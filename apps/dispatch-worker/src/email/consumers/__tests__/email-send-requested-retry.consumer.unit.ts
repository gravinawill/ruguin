import { type MessageConsumerPort, type SubscribeInput } from '@ruguin/message-broker'
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
    const execute = vi.fn().mockResolvedValue(success({ outcome: 'sent' }))
    const sendEmail = { execute } as unknown as SendEmailUseCase

    await new EmailSendRequestedRetryConsumer(fakeConsumer, sendEmail).onModuleInit()

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
    const execute = vi.fn().mockResolvedValue(success({ outcome: 'sent' }))
    const sendEmail = { execute } as unknown as SendEmailUseCase

    await new EmailSendRequestedRetryConsumer(fakeConsumer, sendEmail).onModuleInit()

    /*
     * emailId/organizationId/projectId must be real UUIDs — the consumer runs this payload through
     * EmailSendRequestedPayloadSchema.safeParse() for real; a schema-invalid payload here would be
     * silently dropped (success(undefined) without ever calling sendEmail.execute), and this test's
     * assertion would fail with a confusing "not called" instead of a clear parse-failure signal.
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
        html: '<p>Hi</p>'
      },
      headers: { attempt: '1', nextAttemptAt: '2026-08-02T12:00:10.000Z' }
    })

    await vi.advanceTimersByTimeAsync(10_000)
    await messagePromise

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001', attempt: 1 })
    )
  })
})
