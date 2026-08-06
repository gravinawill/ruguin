import { BaseError, StatusError } from '@ruguin/shared-domain'

export class DuplicateSenderIdentityEmailError extends BaseError {
  readonly name = 'DuplicateSenderIdentityEmailError'
  readonly status = StatusError.CONFLICT

  constructor(input: { email: string }) {
    super({ message: `A sender identity for ${input.email} is already registered.` })
  }
}
