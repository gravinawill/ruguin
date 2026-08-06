import { BaseError, StatusError } from '@ruguin/shared-domain'

export class InvalidSenderIdentityError extends BaseError {
  readonly name = 'InvalidSenderIdentityError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { reason: string }) {
    super({ message: `Invalid sender identity record: ${input.reason}.` })
  }
}
