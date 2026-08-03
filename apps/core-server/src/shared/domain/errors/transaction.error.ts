import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class TransactionError extends BaseError {
  readonly name = 'TransactionError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'The database transaction failed.' })
  }
}
