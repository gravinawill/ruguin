import {
  EMAIL_SEND_REQUESTED_DLQ_TOPIC,
  EMAIL_SEND_REQUESTED_RETRY_TOPIC,
  EMAIL_STATUS_UPDATED_TOPIC
} from '@ruguin/event-schemas'
import { type MessageProducerPort, MessagePublishError } from '@ruguin/message-broker'
import { type Either, failure, success } from '@ruguin/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SesSendError } from '../../../domain/errors/ses-send.error.ts'
import { type DedupClaimPort } from '../../providers/dedup-claim.port.ts'
import { type EmailSenderPort } from '../../providers/email-sender.port.ts'
import { type RateLimiterPort } from '../../providers/rate-limiter.port.ts'
import { SendEmailUseCase } from '../send-email.use-case.ts'

const infraFailure = (
  message: string
): { isFailure: () => true; isSuccess: () => false; value: { message: string } } => ({
  isFailure: () => true,
  isSuccess: () => false,
  value: { message }
})

const BASE_INPUT = {
  emailId: 'email-1',
  organizationId: 'org-1',
  projectId: 'project-1',
  from: 'a@ruguin.dev',
  to: 'b@ruguin.dev',
  subject: 'Hi',
  html: '<p>Hi</p>',
  text: 'Hi',
  attempt: 0
}

function buildUseCase(overrides: {
  claimed?: boolean
  claimFails?: boolean
  allowed?: boolean
  checkFails?: boolean
  sendResult?: 'success' | 'failure'
  publishResults?: ReadonlyArray<'success' | 'failure'>
}) {
  const claim = vi
    .fn()
    .mockResolvedValue(
      overrides.claimFails === true ? infraFailure('dedup store down') : success({ claimed: overrides.claimed ?? true })
    )
  const release = vi.fn().mockResolvedValue(success(undefined))
  const dedupClaim: DedupClaimPort = { claim, release }

  const check = vi
    .fn()
    .mockResolvedValue(
      overrides.checkFails === true
        ? infraFailure('rate limiter store down')
        : success({ allowed: overrides.allowed ?? true })
    )
  const rateLimiter: RateLimiterPort = { check }

  const send =
    overrides.sendResult === 'failure'
      ? vi.fn().mockResolvedValue(failure(new SesSendError({ message: 'SES down' })))
      : vi.fn().mockResolvedValue(success({ sesMessageId: 'ses-1' }))
  const emailSender: EmailSenderPort = { send }

  const publishError: Either<MessagePublishError, void> = failure(
    new MessagePublishError({ message: 'broker unavailable' })
  )
  const publishQueue = [...(overrides.publishResults ?? [])]
  // eslint-disable-next-line @typescript-eslint/require-await -- Satisfies async publish contract; stub has nothing to await
  const publish = vi.fn<MessageProducerPort['publish']>().mockImplementation(async () => {
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

  it('propagates a failure from the dedup claim store instead of proceeding', async () => {
    const { useCase, send } = buildUseCase({ claimFails: true })

    const result = await useCase.execute(BASE_INPUT)

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.message).toBe('dedup store down')
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('propagates a failure from the rate limiter store instead of treating it as allowed or denied', async () => {
    const { useCase, send, release } = buildUseCase({ checkFails: true })

    const result = await useCase.execute(BASE_INPUT)

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.message).toBe('rate limiter store down')
    }
    expect(send).not.toHaveBeenCalled()
    /*
     * A rate-limiter-store failure happens before any side effect, so the claim is released
     * exactly like every other post-claim failure — the redelivered message gets a real retry.
     */
    expect(release).toHaveBeenCalledWith({ key: 'email-1-0' })
  })

  it('reschedules at the SAME attempt when the rate limit is exceeded, so throttling alone never exhausts retries, and releases the claim so the redelivered retry is not skipped as a duplicate', async () => {
    const { useCase, publish, release } = buildUseCase({ allowed: false })

    const result = await useCase.execute(BASE_INPUT)

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.outcome).toBe('retry-scheduled')
    }
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EMAIL_SEND_REQUESTED_RETRY_TOPIC,
        headers: expect.objectContaining({ attempt: '0' })
      })
    )
    /*
     * computeNextRetryAt applies half jitter, so the published nextAttemptAt lands somewhere in
     * [ceiling/2, ceiling] rather than at the exact ceiling — assert the range, not a timestamp.
     */
    const [rescheduleCall] = publish.mock.calls.find(([call]) => call.topic === EMAIL_SEND_REQUESTED_RETRY_TOPIC)!
    const nextAttemptAtMs = Date.parse(rescheduleCall.headers!.nextAttemptAt!)
    expect(nextAttemptAtMs).toBeGreaterThanOrEqual(Date.parse('2026-08-02T12:00:02.500Z'))
    expect(nextAttemptAtMs).toBeLessThanOrEqual(Date.parse('2026-08-02T12:00:05.000Z'))
    /*
     * This path republishes at the SAME attempt (unlike scheduleRetryOrGiveUp, which advances it),
     * so the redelivered message would compute the exact same dedup key. Without releasing here,
     * that redelivery finds the key still claimed and is silently skipped as a duplicate — the
     * email is never actually sent.
     */
    expect(release).toHaveBeenCalledWith({ key: 'email-1-0' })
  })

  it('releases the dedup claim so a redelivery can retry when the rate-limit reschedule publish itself fails', async () => {
    const { useCase, release } = buildUseCase({ allowed: false, publishResults: ['failure'] })

    const result = await useCase.execute(BASE_INPUT)

    expect(result.isFailure()).toBe(true)
    expect(release).toHaveBeenCalledWith({ key: 'email-1-0' })
  })

  it('propagates a failure when the same-attempt dedup release itself fails after a successful reschedule publish, so Kafka does not commit and the key gets another release attempt', async () => {
    const { useCase, release } = buildUseCase({ allowed: false })
    release.mockResolvedValueOnce(infraFailure('dedup store down'))

    const result = await useCase.execute(BASE_INPUT)

    /*
     * The retry-topic publish already succeeded before the release failed, so returning success
     * here would let Kafka commit the offset with the dedup key still held — the redelivered
     * retry would then be silently skipped as a duplicate for the rest of the claim's TTL.
     * execute()'s own failure handler retries the release once more on the same key.
     */
    expect(result.isFailure()).toBe(true)
    expect(release).toHaveBeenCalledTimes(2)
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

  it('propagates a failure when the retry-topic publish itself fails after a genuine SES failure', async () => {
    const { useCase, release } = buildUseCase({ sendResult: 'failure', publishResults: ['failure'] })

    const result = await useCase.execute({ ...BASE_INPUT, attempt: 2 })

    expect(result.isFailure()).toBe(true)
    expect(release).toHaveBeenCalledWith({ key: 'email-1-2' })
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

  it('propagates a failure when the terminal status=failed publish itself fails, never reaching the DLQ publish', async () => {
    const { useCase, publish, release } = buildUseCase({ sendResult: 'failure', publishResults: ['failure'] })

    const result = await useCase.execute({ ...BASE_INPUT, attempt: 3 })

    expect(result.isFailure()).toBe(true)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ topic: EMAIL_SEND_REQUESTED_DLQ_TOPIC }))
    expect(release).toHaveBeenCalledWith({ key: 'email-1-3' })
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
