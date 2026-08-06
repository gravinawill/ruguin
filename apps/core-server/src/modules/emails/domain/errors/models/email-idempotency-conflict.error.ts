import { BaseError, StatusError } from '@ruguin/shared-domain'

export class EmailIdempotencyConflictError extends BaseError {
  readonly name = 'EmailIdempotencyConflictError'
  readonly status = StatusError.CONFLICT

  constructor(input: { idempotencyKey: string }) {
    super({ message: `Idempotency-Key "${input.idempotencyKey}" was already used with a different request body.` })
  }
}
