import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import {
  SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
  SesNotificationCorrelationPendingPayloadSchema
} from '@ruguin/event-schemas'
import {
  MESSAGE_CONSUMER_PORT,
  MESSAGE_PRODUCER_PORT,
  type MessageConsumerPort,
  type MessageProducerPort
} from '@ruguin/message-broker'
import { failure, success } from '@ruguin/utils'

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
    await this.consumer.subscribe({
      topic: SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
      groupId: CORRELATION_RETRY_CONSUMER_GROUP_ID,
      onMessage: async (message) => {
        const parsed = SesNotificationCorrelationPendingPayloadSchema.safeParse(message.payload)
        if (!parsed.success) {
          this.logger.warn(`Malformed correlation-retry payload (eventId=${message.eventId}); routing to DLQ.`)
          return publishMalformedNotificationToDlq(this.producer, {
            rawBody: message.payload,
            reason: parsed.error.message
          })
        }

        const attempt = Number(message.headers.attempt ?? '0')
        const nextAttemptAt = new Date(message.headers.nextAttemptAt ?? new Date().toISOString())

        /*
         * Same defensive check as apps/dispatch-worker's retry consumer: a producer bug or
         * hand-crafted message could carry a non-numeric attempt or unparseable nextAttemptAt.
         */
        if (!Number.isSafeInteger(attempt) || Number.isNaN(nextAttemptAt.getTime())) {
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
    })
  }
}
