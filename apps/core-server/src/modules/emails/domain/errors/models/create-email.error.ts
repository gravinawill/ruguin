import { BaseError, StatusError } from '@ruguin/shared-domain'

export class CreateEmailError extends BaseError {
  readonly name = 'CreateEmailError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to persist the email.' })
  }
}
