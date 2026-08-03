import { Inject, Injectable, type OnModuleInit } from '@nestjs/common'
import { EMAIL_SEND_REQUESTED_RETRY_TOPIC, EmailSendRequestedPayloadSchema } from '@ruguin/event-schemas'
import { MESSAGE_CONSUMER_PORT, type MessageConsumerPort } from '@ruguin/message-broker'
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
    private readonly sendEmail: SendEmailUseCase
  ) {}

  public async onModuleInit(): Promise<void> {
    await this.consumer.subscribe({
      topic: EMAIL_SEND_REQUESTED_RETRY_TOPIC,
      groupId: RETRY_CONSUMER_GROUP_ID,
      onMessage: async (message) => {
        const parsed = EmailSendRequestedPayloadSchema.safeParse(message.payload)
        if (!parsed.success) return success(undefined)

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
