import { BaseError, StatusError } from '@ruguin/shared-domain'

export class FindSenderIdentityError extends BaseError {
  readonly name = 'FindSenderIdentityError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to look up the sender identity.' })
  }
}
