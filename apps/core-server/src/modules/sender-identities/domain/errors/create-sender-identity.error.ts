import { BaseError, StatusError } from '@ruguin/shared-domain'

export class CreateSenderIdentityError extends BaseError {
  readonly name = 'CreateSenderIdentityError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to create the sender identity.' })
  }
}
