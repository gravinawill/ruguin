import { BaseError, StatusError } from '@ruguin/shared-domain'

export class CheckSesIdentityError extends BaseError {
  readonly name = 'CheckSesIdentityError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to check the SES verification status.' })
  }
}
