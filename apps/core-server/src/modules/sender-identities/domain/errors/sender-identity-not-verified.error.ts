import { BaseError, StatusError } from '@ruguin/shared-domain'

export class SenderIdentityNotVerifiedError extends BaseError {
  readonly name = 'SenderIdentityNotVerifiedError'
  readonly status = StatusError.UNPROCESSABLE

  constructor(input: { senderIdentityId: string }) {
    super({ message: `Sender identity ${input.senderIdentityId} is not verified yet.` })
  }
}
