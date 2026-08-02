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
  from: 'a@ruguin.dev',
  to: 'b@ruguin.dev',
  subject: 'Hi',
  html: '<p>Hi</p>',
  attempt: 0
}

function buildUseCase(overrides: { claimed?: boolean; allowed?: boolean; sendResult?: 'success' | 'failure' }) {
  const claim = vi.fn().mockResolvedValue(success({ claimed: overrides.claimed ?? true }))
  const dedupClaim: DedupClaimPort = { claim }

  const check = vi.fn().mockResolvedValue(success({ allowed: overrides.allowed ?? true }))
  const rateLimiter: RateLimiterPort = { check }

  const send =
    overrides.sendResult === 'failure'
      ? vi.fn().mockResolvedValue({ isFailure: () => true, isSuccess: () => false, value: { message: 'SES down' } })
      : vi.fn().mockResolvedValue(success({ sesMessageId: 'ses-1' }))
  const emailSender: EmailSenderPort = { send }

  const publish = vi.fn().mockResolvedValue(success(undefined))
  const messageProducer: MessageProducerPort = { publish }

  const useCase = new SendEmailUseCase(dedupClaim, rateLimiter, emailSender, messageProducer)

  return { useCase, claim, check, send, publish }
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
    const { useCase, publish } = buildUseCase({})

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

  it('schedules a retry when the rate limit is exceeded, at attempt+1', async () => {
    const { useCase, publish } = buildUseCase({ allowed: false })

    const result = await useCase.execute(BASE_INPUT)

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.outcome).toBe('retry-scheduled')
    }
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EMAIL_SEND_REQUESTED_RETRY_TOPIC,
        headers: { attempt: '1', nextAttemptAt: '2026-08-02T12:00:10.000Z' }
      })
    )
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

  it('gives up, publishes status=failed, and routes to the DLQ once retries are exhausted', async () => {
    const { useCase, publish } = buildUseCase({ sendResult: 'failure' })

    const result = await useCase.execute({ ...BASE_INPUT, attempt: 3 })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.outcome).toBe('exhausted')
    }
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EMAIL_STATUS_UPDATED_TOPIC,
        message: expect.objectContaining({ payload: { emailId: 'email-1', status: 'failed' } })
      })
    )
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ topic: EMAIL_SEND_REQUESTED_DLQ_TOPIC }))
  })
})
