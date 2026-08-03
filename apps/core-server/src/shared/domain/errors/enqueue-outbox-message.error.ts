import { BaseError, StatusError } from '@ruguin/shared-domain'

export class EnqueueOutboxMessageError extends BaseError {
  readonly name = 'EnqueueOutboxMessageError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to enqueue the outbox message.' })
  }
}
