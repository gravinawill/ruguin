import { randomUUID } from 'node:crypto'

import { Inject, Injectable, Logger } from '@nestjs/common'
import { EMAIL_STATUS_UPDATED_TOPIC, SES_NOTIFICATION_CORRELATION_RETRY_TOPIC } from '@ruguin/event-schemas'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '@ruguin/message-broker'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { publishMalformedNotificationToDlq } from '../../consumers/dlq-routing.ts'
import { CORRELATION_PROVIDER, type CorrelationPort } from '../../domain/contracts/correlation.port.ts'
import { DEDUP_CLAIM_PROVIDER, type DedupClaimPort } from '../../domain/contracts/dedup-claim.port.ts'
import { type SesNotificationEvent } from '../../domain/models/ses-notification-event.model.ts'
import { computeNextCorrelationRetryAt } from '../correlation-retry-backoff.ts'

/*
 * 24h — matches EventBridge's default maximumEventAgeInSeconds (86400s) for API Destination target
 * retries; the target's retry policy must keep maximumEventAgeInSeconds at or below this value (in
 * seconds) for the dedup guarantee to hold.
 */
const DEDUP_CLAIM_TTL_MS = 86_400_000
const RELEASE_RETRY_ATTEMPTS = 3
const RELEASE_RETRY_DELAY_MS = 200

export type IngestSesNotificationInput =
  | Readonly<{ kind: 'malformed'; rawBody: unknown; reason: string }>
  | Readonly<{ kind: 'valid'; eventBridgeId: string; event: SesNotificationEvent }>

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
    if (input.kind === 'malformed') {
      const published = await publishMalformedNotificationToDlq(this.producer, {
        rawBody: input.rawBody,
        reason: input.reason
      })
      if (published.isFailure()) return failure(published.value)
      return success({ outcome: 'malformed-dlq' })
    }

    const { eventBridgeId, event } = input

    const claimed = await this.dedupClaim.claim({ key: eventBridgeId, ttlInMs: DEDUP_CLAIM_TTL_MS })
    if (claimed.isFailure()) return failure(claimed.value)
    if (!claimed.value.claimed) return success({ outcome: 'duplicate-skipped' })

    const lookup = await this.correlation.lookup({ sesMessageId: event.sesMessageId })
    if (lookup.isFailure()) {
      await this.releaseClaimAfterFailure(eventBridgeId)
      return failure(lookup.value)
    }

    if (lookup.value === null) {
      const scheduled = await this.schedulePendingCorrelation(event)
      if (scheduled.isFailure()) {
        await this.releaseClaimAfterFailure(eventBridgeId)
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
        payload: {
          emailId: lookup.value.emailId,
          status: event.status,
          ...(event.bounceType !== undefined && { bounceType: event.bounceType })
        }
      }
    })
    if (published.isFailure()) {
      await this.releaseClaimAfterFailure(eventBridgeId)
      return failure(published.value)
    }

    return success({ outcome: 'published' })
  }

  private schedulePendingCorrelation(event: SesNotificationEvent): Promise<Either<BaseError, void>> {
    const nextAttemptAt = computeNextCorrelationRetryAt(1)

    return this.producer.publish({
      topic: SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
      key: event.sesMessageId,
      message: {
        eventId: randomUUID(),
        name: 'ses.notification.correlation.pending',
        payload: {
          sesMessageId: event.sesMessageId,
          status: event.status,
          ...(event.bounceType !== undefined && { bounceType: event.bounceType })
        }
      },
      headers: { attempt: '1', nextAttemptAt: nextAttemptAt.toISOString() }
    })
  }

  /*
   * Every failure this use case returns happens AFTER the dedup claim was taken. A failed release
   * is retried a few times with a short delay before giving up — without any retry, a single
   * transient Redis error would leave the claim held for the full 24h TTL, and a legitimate
   * EventBridge redelivery in that window would be silently treated as duplicate-skipped instead of
   * actually reprocessing. The TTL still bounds the damage if every retry fails.
   */
  private async releaseClaimAfterFailure(key: string): Promise<void> {
    for (let attempt = 1; attempt <= RELEASE_RETRY_ATTEMPTS; attempt += 1) {
      const released = await this.dedupClaim.release({ key })
      if (released.isSuccess()) return

      this.logger.error(
        `Failed to release dedup claim ${key} (attempt ${attempt}/${RELEASE_RETRY_ATTEMPTS}): ${released.value.message}`
      )
      if (attempt < RELEASE_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RELEASE_RETRY_DELAY_MS))
      }
    }
  }
}
