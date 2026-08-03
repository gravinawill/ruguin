import { randomUUID } from 'node:crypto'

import { Inject, Injectable, Logger } from '@nestjs/common'
import {
  EMAIL_SEND_REQUESTED_DLQ_TOPIC,
  EMAIL_SEND_REQUESTED_RETRY_TOPIC,
  EMAIL_STATUS_UPDATED_TOPIC
} from '@ruguin/event-schemas'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '@ruguin/message-broker'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { DEDUP_CLAIM_PROVIDER, type DedupClaimPort } from '../providers/dedup-claim.port.ts'
import { EMAIL_SENDER_PROVIDER, type EmailSenderPort } from '../providers/email-sender.port.ts'
import { RATE_LIMITER_PROVIDER, type RateLimiterPort } from '../providers/rate-limiter.port.ts'
import { computeNextRetryAt, hasExhaustedRetries } from '../retry-backoff.ts'

const DEDUP_CLAIM_TTL_MS = 60_000
const SES_RATE_LIMIT_KEY = 'ses-account'

/*
 * A plain configured number, not a port — SES_SEND_RATE_LIMIT_PER_SECOND (packages/env's
 * awsENV) is read once in EmailModule and handed in as a value, the same way every other
 * environment-derived setting in this app stays out of application-layer classes so their unit
 * tests never need real env vars.
 */
export const SES_RATE_LIMIT_PER_SECOND_PROVIDER = Symbol('SES_RATE_LIMIT_PER_SECOND_PROVIDER')

export type SendEmailUseCaseInput = Readonly<{
  emailId: string
  organizationId: string
  projectId: string
  from: string
  to: string
  subject: string
  html: string
  /*
   * Zod-optional fields infer as `T | undefined`, not just optional — match that spelling for
   * exactOptionalPropertyTypes compatibility when consumers spread parsed payloads in directly.
   */
  idempotencyKey?: string | undefined
  attempt: number
}>

export type SendEmailUseCaseOutput = Readonly<{
  outcome: 'sent' | 'skipped-duplicate' | 'retry-scheduled' | 'exhausted'
}>

@Injectable()
export class SendEmailUseCase {
  private readonly logger = new Logger(SendEmailUseCase.name)

  constructor(
    @Inject(DEDUP_CLAIM_PROVIDER) private readonly dedupClaim: DedupClaimPort,
    @Inject(RATE_LIMITER_PROVIDER) private readonly rateLimiter: RateLimiterPort,
    @Inject(EMAIL_SENDER_PROVIDER) private readonly emailSender: EmailSenderPort,
    @Inject(MESSAGE_PRODUCER_PORT) private readonly messageProducer: MessageProducerPort,
    @Inject(SES_RATE_LIMIT_PER_SECOND_PROVIDER) private readonly sesRateLimitPerSecond: number
  ) {}

  public async execute(input: SendEmailUseCaseInput): Promise<Either<BaseError, SendEmailUseCaseOutput>> {
    const dedupKey = SendEmailUseCase.dedupKeyFor(input)

    const claimed = await this.dedupClaim.claim({ key: dedupKey, ttlInMs: DEDUP_CLAIM_TTL_MS })
    if (claimed.isFailure()) return failure(claimed.value)
    if (!claimed.value.claimed) return success({ outcome: 'skipped-duplicate' })

    const result = await this.processClaimedAttempt(input)

    /*
     * Every failure() this use case can return happens AFTER the claim above was taken — it means
     * a downstream Kafka publish failed following a decision that was already made (sent, rate
     * limited, or scheduled for retry/DLQ). KafkaMessageConsumer will not commit this message on a
     * failure result, so Kafka redelivers it. Without releasing the claim here, that redelivery
     * would find dedupKey still held and get treated as a duplicate for the rest of its TTL —
     * either silently dropping the message forever (redelivery within the TTL) or duplicating the
     * SES send (redelivery after the TTL expires, when the claim finally lapses on its own).
     * Releasing it lets the redelivered message actually retry the step that failed. The one
     * accepted trade-off: if SES already succeeded and only the *following* publish failed,
     * releasing means the retried attempt calls SES again — a narrow window (SES succeeds AND the
     * immediate follow-up Kafka publish fails) traded deliberately against the certain data loss
     * this replaces.
     */
    if (result.isFailure()) {
      const released = await this.dedupClaim.release({ key: dedupKey })
      if (released.isFailure()) {
        this.logger.error(`Failed to release dedup claim ${dedupKey}: ${released.value.message}`)
      }
    }

    return result
  }

  // KeyBuilder forbids ":" in key segments (packages/cache/src/infra/key-builder.ts).
  private static dedupKeyFor(input: SendEmailUseCaseInput): string {
    return `${input.emailId}-${input.attempt}`
  }

  private async processClaimedAttempt(
    input: SendEmailUseCaseInput
  ): Promise<Either<BaseError, SendEmailUseCaseOutput>> {
    const rateLimit = await this.rateLimiter.check({
      key: SES_RATE_LIMIT_KEY,
      limit: this.sesRateLimitPerSecond,
      windowInMs: 1000
    })
    if (rateLimit.isFailure()) return failure(rateLimit.value)
    if (!rateLimit.value.allowed) return this.rescheduleWithoutAdvancing(input)

    const sent = await this.emailSender.send({
      from: input.from,
      to: input.to,
      subject: input.subject,
      html: input.html
    })

    if (sent.isSuccess()) {
      const published = await this.publishStatusUpdated(input.emailId, 'sent', sent.value.sesMessageId)
      if (published.isFailure()) return failure(published.value)

      this.logger.log(`Sent ${input.emailId} (attempt ${input.attempt}), ses message id ${sent.value.sesMessageId}.`)
      return success({ outcome: 'sent' })
    }

    return this.scheduleRetryOrGiveUp(input, sent.value.message)
  }

  /*
   * Rate limiting is flow control, not a delivery failure — the email is still perfectly valid and
   * deserves the full MAX_RETRY_ATTEMPTS budget against real send failures. Republishing to the
   * retry topic at the SAME attempt (never scheduleRetryOrGiveUp, which always advances it and can
   * exhaust into the DLQ) means a burst of throttling alone can never DLQ a good email.
   */
  private async rescheduleWithoutAdvancing(
    input: SendEmailUseCaseInput
  ): Promise<Either<BaseError, SendEmailUseCaseOutput>> {
    const nextAttemptAt = computeNextRetryAt(input.attempt)

    const publishedRetry = await this.messageProducer.publish({
      topic: EMAIL_SEND_REQUESTED_RETRY_TOPIC,
      key: input.emailId,
      message: { eventId: randomUUID(), name: 'email.send.requested', payload: input },
      headers: { attempt: String(input.attempt), nextAttemptAt: nextAttemptAt.toISOString() }
    })
    if (publishedRetry.isFailure()) return failure(publishedRetry.value)

    /*
     * Unlike scheduleRetryOrGiveUp (which always advances `attempt`, landing the redelivered
     * message under a fresh dedup key), this path republishes at the SAME attempt on purpose — so
     * the redelivered message computes the exact same dedupKey as this call. Left claimed, that
     * redelivery would find the key still held (the claim's 60s TTL comfortably outlives the ~5-40s
     * backoff) and get skipped as a duplicate: the email would never actually be sent. Releasing
     * here, on the one path that intentionally reuses its own dedup key, is what makes the
     * redelivered retry claimable again.
     */
    const released = await this.dedupClaim.release({ key: SendEmailUseCase.dedupKeyFor(input) })
    if (released.isFailure()) {
      this.logger.error(
        `Failed to release dedup claim for rate-limited retry of ${input.emailId}: ${released.value.message}`
      )
    }

    this.logger.warn(`Rate limit exceeded for ${input.emailId} (attempt ${input.attempt}); rescheduled.`)
    return success({ outcome: 'retry-scheduled' })
  }

  private async scheduleRetryOrGiveUp(
    input: SendEmailUseCaseInput,
    failureReason: string
  ): Promise<Either<BaseError, SendEmailUseCaseOutput>> {
    const nextAttempt = input.attempt + 1

    if (hasExhaustedRetries(nextAttempt)) {
      const publishedFailed = await this.publishStatusUpdated(input.emailId, 'failed', undefined, failureReason)
      if (publishedFailed.isFailure()) return failure(publishedFailed.value)

      const publishedDlq = await this.messageProducer.publish({
        topic: EMAIL_SEND_REQUESTED_DLQ_TOPIC,
        key: input.emailId,
        message: { eventId: randomUUID(), name: 'email.send.requested', payload: input },
        headers: { attempt: String(nextAttempt) }
      })
      if (publishedDlq.isFailure()) return failure(publishedDlq.value)

      this.logger.error(`Exhausted retries for ${input.emailId} after ${nextAttempt} attempts: ${failureReason}`)
      return success({ outcome: 'exhausted' })
    }

    const nextAttemptAt = computeNextRetryAt(nextAttempt)

    const publishedRetry = await this.messageProducer.publish({
      topic: EMAIL_SEND_REQUESTED_RETRY_TOPIC,
      key: input.emailId,
      message: { eventId: randomUUID(), name: 'email.send.requested', payload: input },
      headers: { attempt: String(nextAttempt), nextAttemptAt: nextAttemptAt.toISOString() }
    })
    if (publishedRetry.isFailure()) return failure(publishedRetry.value)

    this.logger.warn(
      `Scheduled retry ${nextAttempt} for ${input.emailId} at ${nextAttemptAt.toISOString()}: ${failureReason}`
    )
    return success({ outcome: 'retry-scheduled' })
  }

  private async publishStatusUpdated(
    emailId: string,
    status: 'sent' | 'failed',
    sesMessageId?: string,
    errorMessage?: string
  ): Promise<Either<BaseError, void>> {
    return this.messageProducer.publish({
      topic: EMAIL_STATUS_UPDATED_TOPIC,
      key: emailId,
      message: {
        eventId: randomUUID(),
        name: 'email.status.updated',
        payload: {
          emailId,
          status,
          ...(sesMessageId !== undefined && { sesMessageId }),
          ...(errorMessage !== undefined && { errorMessage })
        }
      }
    })
  }
}
