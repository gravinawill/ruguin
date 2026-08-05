import { randomUUID } from 'node:crypto'

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import {
  EMAIL_STATUS_UPDATED_DLQ_TOPIC,
  EMAIL_STATUS_UPDATED_TOPIC,
  EmailStatusUpdatedPayloadSchema,
  EmailStatusUpdatedStatus
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

import { RecordSentCorrelationUseCase } from '../application/use-cases/record-sent-correlation.use-case.ts'
import { SentEmailCorrelation } from '../domain/models/sent-email-correlation.model.ts'

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
    const subscribed = await this.consumer.subscribe({
      topic: EMAIL_STATUS_UPDATED_TOPIC,
      groupId: CORRELATION_CONSUMER_GROUP_ID,
      onMessage: (message): Promise<Either<BaseError, void>> => this.onMessage(message)
    })

    /*
     * A failed subscription means this app has no way to ever learn a sesMessageId -> emailId
     * correlation — every future SES notification would dead-end at "lookup-pending" and eventually
     * the DLQ. Crashing bootstrap here, instead of running "healthy" with a silently dead consumer,
     * lets the process manager restart it instead of masking the outage.
     */
    if (subscribed.isFailure()) {
      throw new Error(`Failed to subscribe to ${EMAIL_STATUS_UPDATED_TOPIC}: ${subscribed.value.message}`)
    }
  }

  private async onMessage(message: InboundMessage): Promise<Either<BaseError, void>> {
    const parsed = EmailStatusUpdatedPayloadSchema.safeParse(message.payload)
    if (!parsed.success) {
      this.logger.warn(`Malformed email.status.updated payload (eventId=${message.eventId}); routing to DLQ.`)
      return this.publishToDlq(message)
    }

    /*
     * Only status=sent (published by dispatch-worker) carries the emailId+sesMessageId pair this
     * table exists to record. Every other status on this topic — including
     * delivered/bounced/complained, which this app itself publishes — has nothing to correlate, so
     * it's skipped, not an error.
     */
    if (parsed.data.status !== EmailStatusUpdatedStatus.SENT || parsed.data.sesMessageId === undefined) {
      return success(undefined)
    }

    const correlation = SentEmailCorrelation.create({
      sesMessageId: parsed.data.sesMessageId,
      emailId: parsed.data.emailId
    })
    if (correlation.isFailure()) {
      this.logger.warn(
        `Invalid sent-correlation for eventId=${message.eventId}: ${correlation.value.message}; routing to DLQ.`
      )
      return this.publishToDlq(message)
    }

    const result = await this.recordSentCorrelation.execute(correlation.value)
    if (result.isFailure()) return failure(result.value)

    return success(undefined)
  }

  private publishToDlq(message: InboundMessage): Promise<Either<BaseError, void>> {
    return this.producer.publish({
      topic: EMAIL_STATUS_UPDATED_DLQ_TOPIC,
      key: message.eventId,
      message: { eventId: randomUUID(), name: 'email.status.updated', payload: message.payload },
      headers: message.headers
    })
  }
}
