import { EMAIL_STATUS_UPDATED_TOPIC, SES_NOTIFICATION_CORRELATION_RETRY_TOPIC } from '@ruguin/event-schemas'
import { type MessageProducerPort } from '@ruguin/message-broker'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { CORRELATION_RETRY_MAX_ATTEMPTS } from '../../correlation-retry-backoff.ts'
import { type CorrelationPort } from '../../providers/correlation.port.ts'
import { ResolvePendingCorrelationUseCase } from '../resolve-pending-correlation.use-case.ts'

function buildUseCase(overrides: {
  correlation?: Partial<CorrelationPort>
  producer?: Partial<MessageProducerPort>
}): ResolvePendingCorrelationUseCase {
  const correlation: CorrelationPort = {
    lookup: vi.fn().mockResolvedValue(success(null)),
    upsert: vi.fn(),
    ...overrides.correlation
  }

  const producer: MessageProducerPort = {
    publish: vi.fn().mockResolvedValue(success(undefined)),
    ...overrides.producer
  }

  return new ResolvePendingCorrelationUseCase(correlation, producer)
}

describe('ResolvePendingCorrelationUseCase', () => {
  it('publishes email.status.updated when the correlation now exists', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({
      correlation: { lookup: vi.fn().mockResolvedValue(success({ emailId: 'email-1' })) },
      producer: { publish }
    })

    const result = await useCase.execute({
      sesMessageId: 'ses-msg-1',
      status: 'bounced',
      bounceType: 'Permanent',
      attempt: 1
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('published')
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EMAIL_STATUS_UPDATED_TOPIC,
        key: 'email-1',
        message: expect.objectContaining({
          payload: { emailId: 'email-1', status: 'bounced', bounceType: 'Permanent' }
        })
      })
    )
  })

  it('propagates a correlation lookup failure', async () => {
    const lookupError = { name: 'CorrelationLookupError', message: 'db down' }
    const useCase = buildUseCase({ correlation: { lookup: vi.fn().mockResolvedValue(failure(lookupError)) } })

    const result = await useCase.execute({ sesMessageId: 'ses-msg-1', status: 'delivered', attempt: 1 })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(lookupError)
  })

  it('reschedules the retry when the correlation is still missing and attempts remain', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({ producer: { publish } })

    const result = await useCase.execute({ sesMessageId: 'ses-msg-1', status: 'delivered', attempt: 1 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('retry-scheduled')
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
        key: 'ses-msg-1',
        headers: { attempt: '2', nextAttemptAt: expect.any(String) }
      })
    )
  })

  it('routes to the DLQ once retries are exhausted', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({ producer: { publish } })

    const result = await useCase.execute({
      sesMessageId: 'ses-msg-1',
      status: 'delivered',
      attempt: CORRELATION_RETRY_MAX_ATTEMPTS
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('exhausted')
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { attempt: String(CORRELATION_RETRY_MAX_ATTEMPTS + 1) } })
    )
  })

  it('fails when publishing email.status.updated fails', async () => {
    const publishError = { name: 'MessagePublishError', message: 'kafka down' }
    const useCase = buildUseCase({
      correlation: { lookup: vi.fn().mockResolvedValue(success({ emailId: 'email-1' })) },
      producer: { publish: vi.fn().mockResolvedValue(failure(publishError)) }
    })

    const result = await useCase.execute({ sesMessageId: 'ses-msg-1', status: 'delivered', attempt: 1 })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(publishError)
  })

  it('fails when rescheduling the retry fails', async () => {
    const publishError = { name: 'MessagePublishError', message: 'kafka down' }
    const useCase = buildUseCase({ producer: { publish: vi.fn().mockResolvedValue(failure(publishError)) } })

    const result = await useCase.execute({ sesMessageId: 'ses-msg-1', status: 'delivered', attempt: 1 })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(publishError)
  })
})
