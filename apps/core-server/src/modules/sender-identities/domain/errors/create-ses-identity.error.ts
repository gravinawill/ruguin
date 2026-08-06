import { BaseError, StatusError } from '@ruguin/shared-domain'

export class CreateSesIdentityError extends BaseError {
  readonly name = 'CreateSesIdentityError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to register the sender identity with SES.' })
  }
}
