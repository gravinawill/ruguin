import { randomUUID } from 'node:crypto'

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import {
  EMAIL_STATUS_UPDATED_DLQ_TOPIC,
  EMAIL_STATUS_UPDATED_TOPIC,
  EmailStatusUpdatedPayloadSchema,
  EmailStatusUpdatedStatus
} from '@ruguin/event-schemas'
import {
  MESSAGE_CONSUMER_PORT,
  MESSAGE_PRODUCER_PORT,
  type MessageConsumerPort,
  type MessageProducerPort
} from '@ruguin/message-broker'
import { failure, success } from '@ruguin/utils'

import { RecordSentCorrelationUseCase } from '../application/use-cases/record-sent-correlation.use-case.ts'

export const CORRELATION_CONSUMER_GROUP_ID = 'ses-webhook-ingestor-correlation'

@Injectable()
export class EmailStatusUpdatedSentConsumer implements OnModuleInit {
  private readonly logger = new Logger(EmailStatusUpdatedSentConsumer.name)

  constructor(
    @Inject(MESSAGE_CONSUMER_PORT) private readonly consumer: MessageConsumerPort,
    @Inject(MESSAGE_PRODUCER_PORT) private readonly producer: MessageProducerPort,
    private readonly recordSentCorrelation: RecordSentCorrelationUseCase
  ) {}

  public async onModuleInit(): Promise<void> {
    await this.consumer.subscribe({
      topic: EMAIL_STATUS_UPDATED_TOPIC,
      groupId: CORRELATION_CONSUMER_GROUP_ID,
      onMessage: async (message) => {
        const parsed = EmailStatusUpdatedPayloadSchema.safeParse(message.payload)
        if (!parsed.success) {
          this.logger.warn(`Malformed email.status.updated payload (eventId=${message.eventId}); routing to DLQ.`)
          return this.producer.publish({
            topic: EMAIL_STATUS_UPDATED_DLQ_TOPIC,
            key: message.eventId,
            message: { eventId: randomUUID(), name: 'email.status.updated', payload: message.payload },
            headers: message.headers
          })
        }

        /*
         * Only status=sent (published by dispatch-worker) carries the emailId+sesMessageId pair
         * this table exists to record. Every other status on this topic — including
         * delivered/bounced/complained, which this app itself publishes — has nothing to
         * correlate, so it's skipped, not an error.
         */
        if (parsed.data.status !== EmailStatusUpdatedStatus.SENT || parsed.data.sesMessageId === undefined) {
          return success(undefined)
        }

        const result = await this.recordSentCorrelation.execute({
          sesMessageId: parsed.data.sesMessageId,
          emailId: parsed.data.emailId
        })
        if (result.isFailure()) return failure(result.value)

        return success(undefined)
      }
    })
  }
}
