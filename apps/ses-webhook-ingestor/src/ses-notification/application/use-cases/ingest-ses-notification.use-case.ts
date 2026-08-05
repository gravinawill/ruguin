import { randomUUID } from 'node:crypto'

import { Inject, Injectable, Logger } from '@nestjs/common'
import { EMAIL_STATUS_UPDATED_TOPIC, SES_NOTIFICATION_CORRELATION_RETRY_TOPIC } from '@ruguin/event-schemas'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '@ruguin/message-broker'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { publishMalformedNotificationToDlq } from '../../consumers/dlq-routing.ts'
import { mapSesEventToStatus } from '../../domain/map-ses-event-to-status.ts'
import { EventBridgeSesNotificationSchema } from '../../presentation/dto/eventbridge-ses-notification.schema.ts'
import { computeNextCorrelationRetryAt } from '../correlation-retry-backoff.ts'
import { CORRELATION_PROVIDER, type CorrelationPort } from '../providers/correlation.port.ts'
import { DEDUP_CLAIM_PROVIDER, type DedupClaimPort } from '../providers/dedup-claim.port.ts'

/*
 * 24h — matches EventBridge's default `maximumEventAgeInSeconds` (86400s) for API Destination
 * target retries. Whoever provisions the EventBridge Rule's target retry policy must keep
 * `maximumEventAgeInSeconds` at or below this value (in seconds) for the dedup guarantee to hold —
 * a redelivery that outlives this claim's TTL can still re-claim successfully and publish a
 * duplicate `email.status.updated`.
 */
const DEDUP_CLAIM_TTL_MS = 86_400_000

export type IngestSesNotificationInput = Readonly<{ body: unknown }>
export type IngestSesNotificationOutcome = 'published' | 'malformed-dlq' | 'duplicate-skipped' | 'lookup-pending'
export type IngestSesNotificationOutput = Readonly<{ outcome: IngestSesNotificationOutcome }>

@Injectable()
export class IngestSesNotificationUseCase {
  private readonly logger = new Logger(IngestSesNotificationUseCase.name)

  constructor(
    @Inject(DEDUP_CLAIM_PROVIDER) private readonly dedupClaim: DedupClaimPort,
    @Inject(CORRELATION_PROVIDER) private readonly correlation: CorrelationPort,
    @Inject(MESSAGE_PRODUCER_PORT) private readonly producer: MessageProducerPort
  ) {}

  public async execute(input: IngestSesNotificationInput): Promise<Either<BaseError, IngestSesNotificationOutput>> {
    const parsed = EventBridgeSesNotificationSchema.safeParse(input.body)
    if (!parsed.success) {
      this.logger.warn(`Malformed EventBridge SES notification: ${parsed.error.message}`)
      const published = await publishMalformedNotificationToDlq(this.producer, {
        rawBody: input.body,
        reason: parsed.error.message
      })
      if (published.isFailure()) return failure(published.value)
      return success({ outcome: 'malformed-dlq' })
    }

    const dedupKey = parsed.data.id
    const claimed = await this.dedupClaim.claim({ key: dedupKey, ttlInMs: DEDUP_CLAIM_TTL_MS })
    if (claimed.isFailure()) return failure(claimed.value)
    if (!claimed.value.claimed) return success({ outcome: 'duplicate-skipped' })

    const mapped = mapSesEventToStatus(parsed.data.detail)
    const sesMessageId = parsed.data.detail.mail.messageId

    const lookup = await this.correlation.lookup({ sesMessageId })
    if (lookup.isFailure()) {
      await this.releaseClaimAfterFailure(dedupKey)
      return failure(lookup.value)
    }

    if (lookup.value === null) {
      const scheduled = await this.schedulePendingCorrelation({ sesMessageId, ...mapped })
      if (scheduled.isFailure()) {
        await this.releaseClaimAfterFailure(dedupKey)
        return failure(scheduled.value)
      }
      return success({ outcome: 'lookup-pending' })
    }

    const published = await this.producer.publish({
      topic: EMAIL_STATUS_UPDATED_TOPIC,
      key: lookup.value.emailId,
      message: {
        eventId: randomUUID(),
        name: 'email.status.updated',
        payload: { emailId: lookup.value.emailId, ...mapped }
      }
    })
    if (published.isFailure()) {
      await this.releaseClaimAfterFailure(dedupKey)
      return failure(published.value)
    }

    return success({ outcome: 'published' })
  }

  private schedulePendingCorrelation(
    input: Readonly<{ sesMessageId: string; status: string; bounceType?: string }>
  ): Promise<Either<BaseError, void>> {
    const nextAttemptAt = computeNextCorrelationRetryAt(1)

    return this.producer.publish({
      topic: SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
      key: input.sesMessageId,
      message: { eventId: randomUUID(), name: 'ses.notification.correlation.pending', payload: input },
      headers: { attempt: '1', nextAttemptAt: nextAttemptAt.toISOString() }
    })
  }

  /*
   * Every failure this use case returns happens AFTER the dedup claim was taken — mirrors
   * apps/dispatch-worker's SendEmailUseCase: without releasing it, a legitimate EventBridge retry
   * of the same event id would be silently treated as a duplicate for the rest of the claim's TTL.
   */
  private async releaseClaimAfterFailure(key: string): Promise<void> {
    const released = await this.dedupClaim.release({ key })
    if (released.isFailure()) {
      this.logger.error(`Failed to release dedup claim ${key}: ${released.value.message}`)
    }
  }
}
