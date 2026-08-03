import { randomUUID } from 'node:crypto'

import { Inject, Injectable, type OnModuleInit } from '@nestjs/common'
import {
  EMAIL_SEND_REQUESTED_DLQ_TOPIC,
  EMAIL_SEND_REQUESTED_RETRY_TOPIC,
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

export const RETRY_CONSUMER_GROUP_ID = 'dispatch-worker-retry'

function waitUntil(dueAt: Date): Promise<void> {
  const waitMs = Math.max(0, dueAt.getTime() - Date.now())
  return new Promise((resolve) => setTimeout(resolve, waitMs))
}

@Injectable()
export class EmailSendRequestedRetryConsumer implements OnModuleInit {
  constructor(
    @Inject(MESSAGE_CONSUMER_PORT) private readonly consumer: MessageConsumerPort,
    @Inject(MESSAGE_PRODUCER_PORT) private readonly producer: MessageProducerPort,
    private readonly sendEmail: SendEmailUseCase
  ) {}

  public async onModuleInit(): Promise<void> {
    await this.consumer.subscribe({
      topic: EMAIL_SEND_REQUESTED_RETRY_TOPIC,
      groupId: RETRY_CONSUMER_GROUP_ID,
      onMessage: async (message) => {
        const parsed = EmailSendRequestedPayloadSchema.safeParse(message.payload)
        if (!parsed.success) {
          // Same rationale as the main consumer — see email-send-requested.consumer.ts.
          return this.producer.publish({
            topic: EMAIL_SEND_REQUESTED_DLQ_TOPIC,
            key: message.eventId,
            message: { eventId: randomUUID(), name: 'email.send.requested', payload: message.payload }
          })
        }

        const attempt = Number(message.headers.attempt ?? '0')
        const nextAttemptAt = new Date(message.headers.nextAttemptAt ?? new Date().toISOString())

        await waitUntil(nextAttemptAt)

        const result = await this.sendEmail.execute({ ...parsed.data, attempt })
        if (result.isFailure()) return failure(result.value)

        return success(undefined)
      }
    })
  }
}
