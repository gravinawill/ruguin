import { BaseError, StatusError } from '@ruguin/shared-domain'

export class TransactionError extends BaseError {
  readonly name = 'TransactionError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'The database transaction failed.' })
  }
}
