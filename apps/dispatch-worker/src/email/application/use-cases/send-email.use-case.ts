import { randomUUID } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'
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
const SES_RATE_LIMIT_PER_SECOND = 14

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
  constructor(
    @Inject(DEDUP_CLAIM_PROVIDER) private readonly dedupClaim: DedupClaimPort,
    @Inject(RATE_LIMITER_PROVIDER) private readonly rateLimiter: RateLimiterPort,
    @Inject(EMAIL_SENDER_PROVIDER) private readonly emailSender: EmailSenderPort,
    @Inject(MESSAGE_PRODUCER_PORT) private readonly messageProducer: MessageProducerPort
  ) {}

  public async execute(input: SendEmailUseCaseInput): Promise<Either<BaseError, SendEmailUseCaseOutput>> {
    const claimed = await this.dedupClaim.claim({
      // KeyBuilder forbids ":" in key segments (packages/cache/src/infra/key-builder.ts).
      key: `${input.emailId}-${input.attempt}`,
      ttlInMs: DEDUP_CLAIM_TTL_MS
    })
    if (claimed.isFailure()) return failure(claimed.value)
    if (!claimed.value.claimed) return success({ outcome: 'skipped-duplicate' })

    const rateLimit = await this.rateLimiter.check({
      key: SES_RATE_LIMIT_KEY,
      limit: SES_RATE_LIMIT_PER_SECOND,
      windowInMs: 1000
    })
    if (rateLimit.isFailure()) return failure(rateLimit.value)
    if (!rateLimit.value.allowed) return this.scheduleRetryOrGiveUp(input, 'Rate limit exceeded')

    const sent = await this.emailSender.send({
      from: input.from,
      to: input.to,
      subject: input.subject,
      html: input.html
    })

    if (sent.isSuccess()) {
      const published = await this.publishStatusUpdated(input.emailId, 'sent', sent.value.sesMessageId)
      if (published.isFailure()) return failure(published.value)

      return success({ outcome: 'sent' })
    }

    return this.scheduleRetryOrGiveUp(input, sent.value.message)
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
