import {
  EMAIL_STATUS_UPDATED_TOPIC,
  SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
  SES_NOTIFICATION_MALFORMED_DLQ_TOPIC
} from '@ruguin/event-schemas'
import { type MessageProducerPort } from '@ruguin/message-broker'
import { failure, success } from '@ruguin/utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type CorrelationPort } from '../../../domain/contracts/correlation.port.ts'
import { type DedupClaimPort } from '../../../domain/contracts/dedup-claim.port.ts'
import {
  type CreateSesNotificationEventInput,
  SesNotificationEvent
} from '../../../domain/models/ses-notification-event.model.ts'
import { type IngestSesNotificationInput, IngestSesNotificationUseCase } from '../ingest-ses-notification.use-case.ts'

function buildEvent(input: CreateSesNotificationEventInput): SesNotificationEvent {
  const created = SesNotificationEvent.create(input)
  if (created.isFailure()) throw new Error(`test fixture is invalid: ${created.value.message}`)

  return created.value
}

function validInput(
  event: SesNotificationEvent = buildEvent({ sesMessageId: 'ses-msg-1', eventType: 'Delivery' })
): IngestSesNotificationInput {
  return { kind: 'valid', eventBridgeId: 'evt-1', event }
}

function buildUseCase(overrides: {
  dedupClaim?: Partial<DedupClaimPort>
  correlation?: Partial<CorrelationPort>
  producer?: Partial<MessageProducerPort>
}): IngestSesNotificationUseCase {
  const dedupClaim = {
    claim: vi.fn().mockResolvedValue(success({ claimed: true })),
    confirm: vi.fn().mockResolvedValue(success(undefined)),
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
  afterEach(() => {
    vi.useRealTimers()
  })

  it('routes a malformed input to the malformed DLQ without touching dedup or correlation', async () => {
    const claim = vi.fn()
    const lookup = vi.fn()
    const dedupClaim = { claim } as unknown as DedupClaimPort
    const correlation = { lookup } as unknown as CorrelationPort
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const useCase = new IngestSesNotificationUseCase(dedupClaim, correlation, {
      publish
    })

    const result = await useCase.execute({ kind: 'malformed', rawBody: { not: 'valid' }, reason: 'bad envelope' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('malformed-dlq')
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: SES_NOTIFICATION_MALFORMED_DLQ_TOPIC,
        message: expect.objectContaining({ payload: { rawBody: { not: 'valid' }, reason: 'bad envelope' } })
      })
    )
    expect(claim).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('fails when publishing the malformed notification to the DLQ fails', async () => {
    const publishError = { name: 'MessagePublishError', message: 'kafka down' }
    const useCase = buildUseCase({ producer: { publish: vi.fn().mockResolvedValue(failure(publishError)) } })

    const result = await useCase.execute({ kind: 'malformed', rawBody: { not: 'valid' }, reason: 'bad envelope' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(publishError)
  })

  it('skips a duplicate EventBridge delivery without looking up the correlation or confirming', async () => {
    const lookup = vi.fn()
    const confirm = vi.fn()
    const useCase = buildUseCase({
      dedupClaim: { claim: vi.fn().mockResolvedValue(success({ claimed: false })), confirm },
      correlation: { lookup }
    })

    const result = await useCase.execute(validInput())

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('duplicate-skipped')
    expect(lookup).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('claims with the short in-flight lease, not the full dedup TTL', async () => {
    const claim = vi.fn().mockResolvedValue(success({ claimed: true }))
    const useCase = buildUseCase({ dedupClaim: { claim } })

    await useCase.execute(validInput())

    expect(claim).toHaveBeenCalledWith({ key: 'evt-1', ttlInMs: 60_000 })
  })

  it('propagates a dedup claim failure', async () => {
    const claimError = { name: 'CacheOperationError', message: 'redis down' }
    const useCase = buildUseCase({ dedupClaim: { claim: vi.fn().mockResolvedValue(failure(claimError)) } })

    const result = await useCase.execute(validInput())

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(claimError)
  })

  it('publishes email.status.updated when the correlation is found', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({ producer: { publish } })

    const result = await useCase.execute(validInput())

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

  it('extends the claim to the full dedup TTL once the status update is published', async () => {
    const confirm = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({ dedupClaim: { confirm } })

    const result = await useCase.execute(validInput())

    expect(result.isSuccess()).toBe(true)
    expect(confirm).toHaveBeenCalledWith({ key: 'evt-1', ttlInMs: 86_400_000 })
  })

  it('extends the claim to the full dedup TTL once a correlation retry is scheduled', async () => {
    const confirm = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({
      dedupClaim: { confirm },
      correlation: { lookup: vi.fn().mockResolvedValue(success(null)) }
    })

    const result = await useCase.execute(validInput())

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('lookup-pending')
    expect(confirm).toHaveBeenCalledWith({ key: 'evt-1', ttlInMs: 86_400_000 })
  })

  it('still reports success when confirming the claim fails — the outcome is already durable', async () => {
    const confirmError = { name: 'CacheOperationError', message: 'redis down' }
    const release = vi.fn()
    const useCase = buildUseCase({
      dedupClaim: { confirm: vi.fn().mockResolvedValue(failure(confirmError)), release }
    })

    const result = await useCase.execute(validInput())

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.outcome).toBe('published')
    expect(release).not.toHaveBeenCalled()
  })

  it('carries the bounceType through to email.status.updated for a bounce notification', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({ producer: { publish } })
    const event = buildEvent({ sesMessageId: 'ses-msg-1', eventType: 'Bounce', bounceType: 'Permanent' })

    const result = await useCase.execute(validInput(event))

    expect(result.isSuccess()).toBe(true)
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EMAIL_STATUS_UPDATED_TOPIC,
        message: expect.objectContaining({
          payload: { emailId: 'email-1', status: 'bounced', bounceType: 'Permanent' }
        })
      })
    )
  })

  it('schedules a correlation retry when the correlation is not yet found', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const useCase = buildUseCase({
      correlation: { lookup: vi.fn().mockResolvedValue(success(null)) },
      producer: { publish }
    })

    const result = await useCase.execute(validInput())

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

    const result = await useCase.execute(validInput())

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

    const result = await useCase.execute(validInput())

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

    const result = await useCase.execute(validInput())

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(publishError)
    expect(release).toHaveBeenCalledWith({ key: 'evt-1' })
  })

  it('retries a failing dedup claim release instead of giving up on the first error', async () => {
    vi.useFakeTimers()

    const releaseError = { name: 'CacheOperationError', message: 'redis blip' }
    const lookupError = { name: 'CorrelationLookupError', message: 'db down' }
    const release = vi
      .fn()
      .mockResolvedValueOnce(failure(releaseError))
      .mockResolvedValueOnce(failure(releaseError))
      .mockResolvedValueOnce(success(undefined))
    const useCase = buildUseCase({
      dedupClaim: { release },
      correlation: { lookup: vi.fn().mockResolvedValue(failure(lookupError)) }
    })

    const resultPromise = useCase.execute(validInput())
    await vi.advanceTimersByTimeAsync(1000)
    const result = await resultPromise

    expect(release).toHaveBeenCalledTimes(3)
    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(lookupError)
  })

  it('gives up releasing the dedup claim after the retry budget is spent', async () => {
    vi.useFakeTimers()

    const releaseError = { name: 'CacheOperationError', message: 'redis down' }
    const lookupError = { name: 'CorrelationLookupError', message: 'db down' }
    const release = vi.fn().mockResolvedValue(failure(releaseError))
    const useCase = buildUseCase({
      dedupClaim: { release },
      correlation: { lookup: vi.fn().mockResolvedValue(failure(lookupError)) }
    })

    const resultPromise = useCase.execute(validInput())
    await vi.advanceTimersByTimeAsync(1000)
    const result = await resultPromise

    expect(release).toHaveBeenCalledTimes(3)
    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(lookupError)
  })
})
