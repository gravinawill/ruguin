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

import { ResolvePendingCorrelationUseCase } from '../application/use-cases/resolve-pending-correlation.use-case.ts'

import { publishMalformedNotificationToDlq } from './dlq-routing.ts'

export const CORRELATION_RETRY_CONSUMER_GROUP_ID = 'ses-webhook-ingestor-retry'

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
     * Absent headers are rejected outright, not defaulted — and attempt must be a positive integer:
     * Number.isSafeInteger alone accepts 0 and negative values, which could reschedule far past the
     * retry ceiling (hasExhaustedCorrelationRetries never trips for a non-positive nextAttempt).
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
