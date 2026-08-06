import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses'
import { Injectable } from '@nestjs/common'
import { type BaseError } from '@ruguin/shared-domain'
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
          Source: input.fromName === undefined ? input.from : `${input.fromName} <${input.from}>`,
          Destination: { ToAddresses: [input.to] },
          Message: {
            Subject: { Data: input.subject },
            Body: { Html: { Data: input.html } }
          }
        })
      )

      /*
       * A successful SendEmailCommand always carries a MessageId per the SES API contract — its
       * absence means the SDK response can't be trusted. Falling back to an empty string would
       * publish a `sent` status event with a sesMessageId that violates
       * EmailStatusUpdatedPayloadSchema's own z.string().min(1); treating it as a failure instead
       * routes it through the normal retry path like any other SES anomaly.
       */
      if (response.MessageId === undefined) {
        /*
         * No recipient/sender address here — this message crosses into the email.status.updated
         * Kafka topic and application logs, and a recipient address is personal data.
         */
        return failure(new SesSendError({ message: 'SES accepted the send but returned no MessageId.' }))
      }

      return success({ sesMessageId: response.MessageId })
    } catch (error: unknown) {
      // Same rationale as above — the original SES error is preserved in `error` for triage.
      return failure(new SesSendError({ error, message: 'Failed to send the email via SES.' }))
    }
  }
}
