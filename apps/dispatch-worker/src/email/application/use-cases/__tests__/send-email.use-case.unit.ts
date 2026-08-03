import {
  EMAIL_SEND_REQUESTED_DLQ_TOPIC,
  EMAIL_SEND_REQUESTED_RETRY_TOPIC,
  EMAIL_STATUS_UPDATED_TOPIC
} from '@ruguin/event-schemas'
import { type MessageProducerPort } from '@ruguin/message-broker'
import { success } from '@ruguin/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type DedupClaimPort } from '../../providers/dedup-claim.port.ts'
import { type EmailSenderPort } from '../../providers/email-sender.port.ts'
import { type RateLimiterPort } from '../../providers/rate-limiter.port.ts'
import { SendEmailUseCase } from '../send-email.use-case.ts'

const BASE_INPUT = {
  emailId: 'email-1',
  organizationId: 'org-1',
  projectId: 'project-1',
  from: 'a@ruguin.dev',
  to: 'b@ruguin.dev',
  subject: 'Hi',
  html: '<p>Hi</p>',
  attempt: 0
}

function buildUseCase(overrides: {
  claimed?: boolean
  allowed?: boolean
  sendResult?: 'success' | 'failure'
  publishResults?: ReadonlyArray<'success' | 'failure'>
}) {
  const claim = vi.fn().mockResolvedValue(success({ claimed: overrides.claimed ?? true }))
  const release = vi.fn().mockResolvedValue(success(undefined))
  const dedupClaim: DedupClaimPort = { claim, release }

  const check = vi.fn().mockResolvedValue(success({ allowed: overrides.allowed ?? true }))
  const rateLimiter: RateLimiterPort = { check }

  const send =
    overrides.sendResult === 'failure'
      ? vi.fn().mockResolvedValue({ isFailure: () => true, isSuccess: () => false, value: { message: 'SES down' } })
      : vi.fn().mockResolvedValue(success({ sesMessageId: 'ses-1' }))
  const emailSender: EmailSenderPort = { send }

  const publishError = { isFailure: () => true, isSuccess: () => false, value: { message: 'broker unavailable' } }
  const publishQueue = [...(overrides.publishResults ?? [])]
  // eslint-disable-next-line @typescript-eslint/require-await -- Satisfies async publish contract; stub has nothing to await
  const publish = vi.fn().mockImplementation(async () => {
    const next = publishQueue.shift()
    return next === 'failure' ? publishError : success(undefined)
  })
  const messageProducer: MessageProducerPort = { publish }

  const useCase = new SendEmailUseCase(dedupClaim, rateLimiter, emailSender, messageProducer, 14)

  return { useCase, claim, release, check, send, publish }
}

describe('SendEmailUseCase', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends and publishes email.status.updated with status=sent on success', async () => {
    const { useCase, publish, release, check } = buildUseCase({})

    const result = await useCase.execute(BASE_INPUT)

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.outcome).toBe('sent')
    }
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EMAIL_STATUS_UPDATED_TOPIC,
        message: expect.objectContaining({
          payload: { emailId: 'email-1', status: 'sent', sesMessageId: 'ses-1' }
        })
      })
    )
    // Proves the rate limit comes from the injected constructor value, not a hardcoded number.
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ limit: 14 }))
    expect(release).not.toHaveBeenCalled()
  })

  it('skips silently when the dedup claim was already taken', async () => {
    const { useCase, send } = buildUseCase({ claimed: false })

    const result = await useCase.execute(BASE_INPUT)

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.outcome).toBe('skipped-duplicate')
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('reschedules at the SAME attempt when the rate limit is exceeded, so throttling alone never exhausts retries', async () => {
    const { useCase, publish, release } = buildUseCase({ allowed: false })

    const result = await useCase.execute(BASE_INPUT)

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.outcome).toBe('retry-scheduled')
    }
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EMAIL_SEND_REQUESTED_RETRY_TOPIC,
        headers: { attempt: '0', nextAttemptAt: '2026-08-02T12:00:05.000Z' }
      })
    )
    expect(release).not.toHaveBeenCalled()
  })

  it('releases the dedup claim so a redelivery can retry when the rate-limit reschedule publish itself fails', async () => {
    const { useCase, release } = buildUseCase({ allowed: false, publishResults: ['failure'] })

    const result = await useCase.execute(BASE_INPUT)

    expect(result.isFailure()).toBe(true)
    expect(release).toHaveBeenCalledWith({ key: 'email-1-0' })
  })

  it('schedules a retry when SES send fails and attempt has not exhausted retries', async () => {
    const { useCase, publish } = buildUseCase({ sendResult: 'failure' })

    const result = await useCase.execute({ ...BASE_INPUT, attempt: 2 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.outcome).toBe('retry-scheduled')
    }
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EMAIL_SEND_REQUESTED_RETRY_TOPIC,
        headers: expect.objectContaining({ attempt: '3' })
      })
    )
  })

  it('gives up, publishes status=failed with the failure reason, and routes to the DLQ with the terminal attempt count once retries are exhausted', async () => {
    const { useCase, publish } = buildUseCase({ sendResult: 'failure' })

    const result = await useCase.execute({ ...BASE_INPUT, attempt: 3 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.outcome).toBe('exhausted')
    }
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EMAIL_STATUS_UPDATED_TOPIC,
        message: expect.objectContaining({
          payload: { emailId: 'email-1', status: 'failed', errorMessage: 'SES down' }
        })
      })
    )
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: EMAIL_SEND_REQUESTED_DLQ_TOPIC, headers: { attempt: '4' } })
    )
  })

  it('releases the dedup claim when the status-updated publish fails after a successful send, so redelivery is not treated as a duplicate', async () => {
    const { useCase, release } = buildUseCase({ publishResults: ['failure'] })

    const result = await useCase.execute(BASE_INPUT)

    expect(result.isFailure()).toBe(true)
    expect(release).toHaveBeenCalledWith({ key: 'email-1-0' })
  })

  it('releases the dedup claim when the DLQ publish fails after retries are exhausted, so the message is not lost for the rest of the TTL', async () => {
    const { useCase, release } = buildUseCase({ sendResult: 'failure', publishResults: ['success', 'failure'] })

    const result = await useCase.execute({ ...BASE_INPUT, attempt: 3 })

    expect(result.isFailure()).toBe(true)
    expect(release).toHaveBeenCalledWith({ key: 'email-1-3' })
  })

  it('does not release the dedup claim when the retry-scheduled publish succeeds after a genuine SES failure', async () => {
    const { useCase, release } = buildUseCase({ sendResult: 'failure' })

    const result = await useCase.execute({ ...BASE_INPUT, attempt: 2 })

    expect(result.isSuccess()).toBe(true)
    expect(release).not.toHaveBeenCalled()
  })
})
