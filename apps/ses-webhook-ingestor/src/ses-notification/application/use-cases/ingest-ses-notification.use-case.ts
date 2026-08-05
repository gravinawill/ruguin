import { randomUUID } from 'node:crypto'

import { Inject, Injectable, Logger } from '@nestjs/common'
import { EMAIL_STATUS_UPDATED_TOPIC, SES_NOTIFICATION_CORRELATION_RETRY_TOPIC } from '@ruguin/event-schemas'
import { MESSAGE_PRODUCER_PORT, type MessageProducerPort } from '@ruguin/message-broker'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { CORRELATION_PROVIDER, type CorrelationPort } from '../../domain/contracts/correlation.port.ts'
import { DEDUP_CLAIM_PROVIDER, type DedupClaimPort } from '../../domain/contracts/dedup-claim.port.ts'
import { type SesNotificationEvent } from '../../domain/models/ses-notification-event.model.ts'
import { computeNextCorrelationRetryAt } from '../correlation-retry-backoff.ts'
import { publishMalformedNotificationToDlq } from '../dlq-routing.ts'

/*
 * 24h — matches EventBridge's default maximumEventAgeInSeconds (86400s) for API Destination target
 * retries; the target's retry policy must keep maximumEventAgeInSeconds at or below this value (in
 * seconds) for the dedup guarantee to hold. Only confirm() ever writes this TTL, once the outcome
 * is durably handled.
 */
const DEDUP_CLAIM_TTL_MS = 86_400_000

/*
 * The in-flight lease the initial claim() takes. Claiming the full 24h up front and relying on
 * release() to undo it is not safe: when the cache circuit breaker is open, delete() fail-opens to
 * success without touching Redis (packages/cache/src/infra/decorators/resilient-cache.provider.ts),
 * so a release reports success while a real 24h key survives — and every redelivery inside that
 * window is skipped as a duplicate although nothing was ever processed. With a lease, the worst
 * case for any path that dies between claim and confirm is a claim stranded for ~60s.
 */
const DEDUP_LEASE_TTL_MS = 60_000

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

    const claimed = await this.dedupClaim.claim({ key: eventBridgeId, ttlInMs: DEDUP_LEASE_TTL_MS })
    if (claimed.isFailure()) return failure(claimed.value)
    if (!claimed.value.claimed) {
      this.logger.debug(`Skipping EventBridge event ${eventBridgeId}: already claimed (redelivery).`)
      return success({ outcome: 'duplicate-skipped' })
    }

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

      await this.confirmClaim(eventBridgeId)
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

    await this.confirmClaim(eventBridgeId)
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
   * Promotes the in-flight lease to the full 24h dedup window now that the outcome is durable.
   * Deliberately best-effort and single-attempt, unlike releaseClaimAfterFailure: a failed release
   * strands a claim (a correctness bug), while a failed confirm only lets the dedup window expire
   * with the lease — a later redelivery would then be reprocessed, which is the same at-least-once
   * behaviour the whole pipeline is already built for. Retrying would put 200ms sleeps on the
   * success path of every webhook request to buy back a best-effort guarantee, so it does not.
   */
  private async confirmClaim(key: string): Promise<void> {
    const confirmed = await this.dedupClaim.confirm({ key, ttlInMs: DEDUP_CLAIM_TTL_MS })
    if (confirmed.isFailure()) {
      this.logger.warn(
        `Failed to confirm dedup claim ${key}: ${confirmed.value.message}. ` +
          `Dedup window stays capped at the ${DEDUP_LEASE_TTL_MS}ms lease.`
      )
    }
  }

  /*
   * Every failure this use case returns happens AFTER the dedup claim was taken. A failed release
   * is retried a few times with a short delay before giving up — without any retry, a single
   * transient Redis error would leave the claim held, and a legitimate EventBridge redelivery in
   * that window would be silently treated as duplicate-skipped instead of actually reprocessing.
   * The lease TTL bounds the damage to ~60s if every retry fails, since a failure path never
   * reaches confirmClaim.
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
