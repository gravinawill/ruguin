import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import {
  SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
  SesNotificationCorrelationPendingPayloadSchema
} from '@ruguin/event-schemas'
import {
  type InboundMessage,
  MESSAGE_CONSUMER_PORT,
  MESSAGE_PRODUCER_PORT,
  type MessageConsumerPort,
  type MessageProducerPort
} from '@ruguin/message-broker'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { publishMalformedNotificationToDlq } from '../application/dlq-routing.ts'
import { ResolvePendingCorrelationUseCase } from '../application/use-cases/resolve-pending-correlation.use-case.ts'

export const CORRELATION_RETRY_CONSUMER_GROUP_ID = 'ses-webhook-ingestor-retry'

/*
 * Blocks the handler — and with it this partition's consumption and graceful shutdown — for up to
 * the last attempt's backoff ceiling (~64s). Deliberate, and the same tradeoff apps/dispatch-worker
 * already accepts: making the sleep abortable means threading a cancellation signal through
 * MessageConsumerPort.subscribe in @ruguin/message-broker, a contract change shared by both apps.
 * Tracked as a follow-up rather than fixed here.
 */
function waitUntil(dueAt: Date): Promise<void> {
  const waitMs = Math.max(0, dueAt.getTime() - Date.now())
  return new Promise((resolve) => setTimeout(resolve, waitMs))
}

@Injectable()
export class SesNotificationCorrelationRetryConsumer implements OnModuleInit {
  private readonly logger = new Logger(SesNotificationCorrelationRetryConsumer.name)

  constructor(
    @Inject(MESSAGE_CONSUMER_PORT) private readonly consumer: MessageConsumerPort,
    @Inject(MESSAGE_PRODUCER_PORT) private readonly producer: MessageProducerPort,
    private readonly resolvePendingCorrelation: ResolvePendingCorrelationUseCase
  ) {}

  public async onModuleInit(): Promise<void> {
    const subscribed = await this.consumer.subscribe({
      topic: SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
      groupId: CORRELATION_RETRY_CONSUMER_GROUP_ID,
      onMessage: (message): Promise<Either<BaseError, void>> => this.onMessage(message)
    })

    /*
     * A failed subscription means every notification that lands on the retry topic is stranded —
     * the correlation would never be resolved and the event never republished. Crashing bootstrap
     * here, instead of running "healthy" with a silently dead consumer, lets the process manager
     * restart it instead of masking the outage.
     */
    if (subscribed.isFailure()) {
      throw new Error(`Failed to subscribe to ${SES_NOTIFICATION_CORRELATION_RETRY_TOPIC}: ${subscribed.value.message}`)
    }
  }

  private async onMessage(message: InboundMessage): Promise<Either<BaseError, void>> {
    const parsed = SesNotificationCorrelationPendingPayloadSchema.safeParse(message.payload)
    if (!parsed.success) {
      this.logger.warn(`Malformed correlation-retry payload (eventId=${message.eventId}); routing to DLQ.`)
      return publishMalformedNotificationToDlq(this.producer, {
        rawBody: message.payload,
        reason: parsed.error.message
      })
    }

    const attemptHeader = message.headers.attempt
    const nextAttemptAtHeader = message.headers.nextAttemptAt
    const attempt = attemptHeader === undefined ? NaN : Number(attemptHeader)
    const nextAttemptAt = nextAttemptAtHeader === undefined ? new Date(NaN) : new Date(nextAttemptAtHeader)

    /*
     * Absent headers are rejected outright, not defaulted — and attempt must be a positive integer,
     * which Number.isSafeInteger alone does not guarantee. The retry budget still terminates for a
     * bogus attempt (it climbs until it passes CORRELATION_RETRY_MAX_ATTEMPTS), so the hazard is
     * not an infinite loop but a corrupted schedule: computeNextCorrelationRetryAt raises 2 to the
     * attempt, so a negative attempt collapses the delay to near-zero and republishes in a tight
     * loop, while attempt=0 silently hands the message a larger budget than the producer intended.
     */
    if (!Number.isSafeInteger(attempt) || attempt < 1 || Number.isNaN(nextAttemptAt.getTime())) {
      this.logger.warn(
        `Malformed correlation-retry headers for eventId=${message.eventId} ` +
          `(attempt=${message.headers.attempt}, nextAttemptAt=${message.headers.nextAttemptAt}); routing to DLQ.`
      )
      return publishMalformedNotificationToDlq(this.producer, {
        rawBody: message.payload,
        reason: 'invalid attempt/nextAttemptAt headers'
      })
    }

    await waitUntil(nextAttemptAt)

    const result = await this.resolvePendingCorrelation.execute({ ...parsed.data, attempt })
    if (result.isFailure()) return failure(result.value)

    return success(undefined)
  }
}
