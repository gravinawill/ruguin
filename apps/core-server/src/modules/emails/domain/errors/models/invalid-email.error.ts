import { BaseError, StatusError } from '@ruguin/shared-domain'

export class InvalidEmailError extends BaseError {
  readonly name = 'InvalidEmailError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { reason: string }) {
    super({ message: `Invalid email: ${input.reason}.` })
  }
}
