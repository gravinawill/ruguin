import {
  EMAIL_STATUS_UPDATED_TOPIC,
  SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
  SES_NOTIFICATION_MALFORMED_DLQ_TOPIC
} from '@ruguin/event-schemas'
import { type MessageProducerPort } from '@ruguin/message-broker'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type CorrelationPort } from '../../providers/correlation.port.ts'
import { type DedupClaimPort } from '../../providers/dedup-claim.port.ts'
import { IngestSesNotificationUseCase } from '../ingest-ses-notification.use-case.ts'

const VALID_BODY = {
  id: 'evt-1',
  source: 'aws.ses',
  detail: { eventType: 'Delivery', mail: { messageId: 'ses-msg-1' } }
}

function buildUseCase(overrides: {
  dedupClaim?: Partial<DedupClaimPort>
  correlation?: Partial<CorrelationPort>
  producer?: Partial<MessageProducerPort>
}): IngestSesNotificationUseCase {
  const dedupClaim = {
    claim: vi.fn().mockResolvedValue(success({ claimed: true })),
    release: vi.fn().mockResolvedValue(success(undefined)),
    ...overrides.dedupClaim
  }

  const correlation = {
    lookup: vi.fn().mockResolvedValue(success({ emailId: 'email-1' })),
    upsert: vi.fn(),
    ...overrides.correlation
  }

  const producer = {
    publish: vi.fn().mockResolvedValue(success(undefined)),
    ...overrides.producer
  }

  return new IngestSesNotificationUseCase(dedupClaim, correlation, producer)
}

describe('IngestSesNotificationUseCase', () => {
  it('routes an invalid body to the malformed DLQ without touching dedup or correlation', async () => {
    const claim = vi.fn()
    const lookup = vi.fn()
    const dedupClaim = { claim } as unknown as DedupClaimPort
    const correlation = { lookup } as unknown as CorrelationPort
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const useCase = new IngestSesNotificationUseCase(dedupClaim, correlation, { publish })

    const result = await useCase.execute({ body: { not: 'valid' } })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('malformed-dlq')
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ topic: SES_NOTIFICATION_MALFORMED_DLQ_TOPIC }))
    expect(claim).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('skips a duplicate EventBridge delivery without looking up the correlation', async () => {
    const lookup = vi.fn()
    const correlation = { lookup } as unknown as CorrelationPort
    const useCase = buildUseCase({
      dedupClaim: { claim: vi.fn().mockResolvedValue(success({ claimed: false })) },
      correlation
    })

    const result = await useCase.execute({ body: VALID_BODY })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('duplicate-skipped')
    expect(lookup).not.toHaveBeenCalled()
  })

  it('propagates a dedup claim failure', async () => {
    const claimError = { name: 'CacheOperationError', message: 'redis down' }
    const useCase = buildUseCase({ dedupClaim: { claim: vi.fn().mockResolvedValue(failure(claimError)) } })

    const result = await useCase.execute({ body: VALID_BODY })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(claimError)
  })

  it('publishes email.status.updated when the correlation is found', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({ producer: { publish } })

    const result = await useCase.execute({ body: VALID_BODY })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('published')
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EMAIL_STATUS_UPDATED_TOPIC,
        key: 'email-1',
        message: expect.objectContaining({ payload: { emailId: 'email-1', status: 'delivered' } })
      })
    )
  })

  it('schedules a correlation retry when the correlation is not yet found', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({
      correlation: { lookup: vi.fn().mockResolvedValue(success(null)) },
      producer: { publish }
    })

    const result = await useCase.execute({ body: VALID_BODY })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('lookup-pending')
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
        key: 'ses-msg-1',
        headers: expect.objectContaining({ attempt: '1' }),
        message: expect.objectContaining({ payload: { sesMessageId: 'ses-msg-1', status: 'delivered' } })
      })
    )
  })

  it('releases the dedup claim and fails when the correlation lookup fails', async () => {
    const lookupError = { name: 'CorrelationLookupError', message: 'db down' }
    const release = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({
      dedupClaim: { release },
      correlation: { lookup: vi.fn().mockResolvedValue(failure(lookupError)) }
    })

    const result = await useCase.execute({ body: VALID_BODY })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(lookupError)
    expect(release).toHaveBeenCalledWith({ key: 'evt-1' })
  })

  it('releases the dedup claim and fails when publishing email.status.updated fails', async () => {
    const publishError = { name: 'MessagePublishError', message: 'kafka down' }
    const release = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({
      dedupClaim: { release },
      producer: { publish: vi.fn().mockResolvedValue(failure(publishError)) }
    })

    const result = await useCase.execute({ body: VALID_BODY })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(publishError)
    expect(release).toHaveBeenCalledWith({ key: 'evt-1' })
  })

  it('releases the dedup claim and fails when scheduling the correlation retry fails', async () => {
    const publishError = { name: 'MessagePublishError', message: 'kafka down' }
    const release = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({
      dedupClaim: { release },
      correlation: { lookup: vi.fn().mockResolvedValue(success(null)) },
      producer: { publish: vi.fn().mockResolvedValue(failure(publishError)) }
    })

    const result = await useCase.execute({ body: VALID_BODY })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(publishError)
    expect(release).toHaveBeenCalledWith({ key: 'evt-1' })
  })
})
