import { randomUUID } from 'node:crypto'

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import {
  EMAIL_SEND_REQUESTED_DLQ_TOPIC,
  EMAIL_SEND_REQUESTED_TOPIC,
  EmailSendRequestedPayloadSchema
} from '@ruguin/event-schemas'
import {
  MESSAGE_CONSUMER_PORT,
  MESSAGE_PRODUCER_PORT,
  type MessageConsumerPort,
  type MessageProducerPort
} from '@ruguin/message-broker'
import { failure, success } from '@ruguin/utils'

import { SendEmailUseCase } from '../application/use-cases/send-email.use-case.ts'

export const MAIN_CONSUMER_GROUP_ID = 'dispatch-worker'

@Injectable()
export class EmailSendRequestedConsumer implements OnModuleInit {
  private readonly logger = new Logger(EmailSendRequestedConsumer.name)

  constructor(
    @Inject(MESSAGE_CONSUMER_PORT) private readonly consumer: MessageConsumerPort,
    @Inject(MESSAGE_PRODUCER_PORT) private readonly producer: MessageProducerPort,
    private readonly sendEmail: SendEmailUseCase
  ) {}

  public async onModuleInit(): Promise<void> {
    await this.consumer.subscribe({
      topic: EMAIL_SEND_REQUESTED_TOPIC,
      groupId: MAIN_CONSUMER_GROUP_ID,
      onMessage: async (message) => {
        const parsed = EmailSendRequestedPayloadSchema.safeParse(message.payload)
        if (!parsed.success) {
          this.logger.warn(`Malformed email.send.requested payload (eventId=${message.eventId}); routing to DLQ.`)

          /*
           * A schema-invalid payload can't be trusted to carry a usable emailId, so the DLQ
           * message is keyed by the inbound eventId (always present on InboundMessage) instead —
           * docs/product-spec.md §3.3/§4.2: malformed messages must reach the DLQ, never be
           * silently discarded.
           */
          return this.producer.publish({
            topic: EMAIL_SEND_REQUESTED_DLQ_TOPIC,
            key: message.eventId,
            message: { eventId: randomUUID(), name: 'email.send.requested', payload: message.payload }
          })
        }

        const result = await this.sendEmail.execute({ ...parsed.data, attempt: 0 })
        if (result.isFailure()) return failure(result.value)

        return success(undefined)
      }
    })
  }
}
