import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses'
import { Injectable } from '@nestjs/common'
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either, failure, success } from '@ruguin/utils'

import {
  type EmailSenderPort,
  type SendEmailInput,
  type SendEmailOutput
} from '../../application/providers/email-sender.port.ts'
import { SesSendError } from '../../domain/errors/ses-send.error.ts'

@Injectable()
export class SesEmailSender implements EmailSenderPort {
  constructor(private readonly client: SESClient) {}

  public async send(input: SendEmailInput): Promise<Either<BaseError, SendEmailOutput>> {
    try {
      const response = await this.client.send(
        new SendEmailCommand({
          Source: input.from,
          Destination: { ToAddresses: [input.to] },
          Message: {
            Subject: { Data: input.subject },
            Body: { Html: { Data: input.html } }
          }
        })
      )

      return success({ sesMessageId: response.MessageId ?? '' })
    } catch (error: unknown) {
      return failure(
        new SesSendError({ error, message: `Failed to send email from "${input.from}" to "${input.to}" via SES.` })
      )
    }
  }
}
