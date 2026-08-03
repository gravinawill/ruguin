import { Inject, Injectable, type OnModuleInit } from '@nestjs/common'
import { EMAIL_SEND_REQUESTED_TOPIC, EmailSendRequestedPayloadSchema } from '@ruguin/event-schemas'
import { MESSAGE_CONSUMER_PORT, type MessageConsumerPort } from '@ruguin/message-broker'
import { failure, success } from '@ruguin/utils'

import { SendEmailUseCase } from '../application/use-cases/send-email.use-case.ts'

export const MAIN_CONSUMER_GROUP_ID = 'dispatch-worker'

@Injectable()
export class EmailSendRequestedConsumer implements OnModuleInit {
  constructor(
    @Inject(MESSAGE_CONSUMER_PORT) private readonly consumer: MessageConsumerPort,
    private readonly sendEmail: SendEmailUseCase
  ) {}

  public async onModuleInit(): Promise<void> {
    await this.consumer.subscribe({
      topic: EMAIL_SEND_REQUESTED_TOPIC,
      groupId: MAIN_CONSUMER_GROUP_ID,
      onMessage: async (message) => {
        const parsed = EmailSendRequestedPayloadSchema.safeParse(message.payload)
        if (!parsed.success) return success(undefined)

        const result = await this.sendEmail.execute({ ...parsed.data, attempt: 0 })
        if (result.isFailure()) return failure(result.value)

        return success(undefined)
      }
    })
  }
}
