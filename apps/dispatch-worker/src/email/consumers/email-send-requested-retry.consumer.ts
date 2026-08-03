import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { EMAIL_SEND_REQUESTED_RETRY_TOPIC, EmailSendRequestedPayloadSchema } from '@ruguin/event-schemas'
import {
  MESSAGE_CONSUMER_PORT,
  MESSAGE_PRODUCER_PORT,
  type MessageConsumerPort,
  type MessageProducerPort
} from '@ruguin/message-broker'
import { failure, success } from '@ruguin/utils'

import { SendEmailUseCase } from '../application/use-cases/send-email.use-case.ts'

import { publishMalformedMessageToDlq } from './dlq-routing.ts'

export const RETRY_CONSUMER_GROUP_ID = 'dispatch-worker-retry'

function waitUntil(dueAt: Date): Promise<void> {
  const waitMs = Math.max(0, dueAt.getTime() - Date.now())
  return new Promise((resolve) => setTimeout(resolve, waitMs))
}

@Injectable()
export class EmailSendRequestedRetryConsumer implements OnModuleInit {
  private readonly logger = new Logger(EmailSendRequestedRetryConsumer.name)

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
          this.logger.warn(`Malformed email.send.requested.retry payload (eventId=${message.eventId}); routing to DLQ.`)
          return publishMalformedMessageToDlq(this.producer, message)
        }

        const attempt = Number(message.headers.attempt ?? '0')
        const nextAttemptAt = new Date(message.headers.nextAttemptAt ?? new Date().toISOString())

        /*
         * A producer bug (or a hand-crafted message on this topic) could carry a non-numeric
         * attempt or an unparseable nextAttemptAt. Left unguarded, Number(...) yields NaN (silently
         * passed through to SendEmailUseCase's retry-exhaustion math) and an invalid Date's
         * .toISOString() throws a RangeError inside forwardMessages' try/catch — caught there, but
         * never committed and never routed anywhere, so the message would retry-loop forever on
         * every redelivery without ever reaching the DLQ. Treating it the same as a schema-invalid
         * payload closes that gap.
         */
        if (!Number.isSafeInteger(attempt) || Number.isNaN(nextAttemptAt.getTime())) {
          this.logger.warn(
            `Malformed retry headers for eventId=${message.eventId} ` +
              `(attempt=${message.headers.attempt}, nextAttemptAt=${message.headers.nextAttemptAt}); routing to DLQ.`
          )
          return publishMalformedMessageToDlq(this.producer, message)
        }

        await waitUntil(nextAttemptAt)

        const result = await this.sendEmail.execute({ ...parsed.data, attempt })
        if (result.isFailure()) return failure(result.value)

        return success(undefined)
      }
    })
  }
}
