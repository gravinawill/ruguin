import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

export const EMAIL_SENDER_PROVIDER = Symbol('EMAIL_SENDER_PROVIDER')

export type SendEmailInput = Readonly<{ from: string; fromName?: string; to: string; subject: string; html: string }>
export type SendEmailOutput = Readonly<{ sesMessageId: string }>

export interface EmailSenderPort {
  send(input: SendEmailInput): Promise<Either<BaseError, SendEmailOutput>>
}
