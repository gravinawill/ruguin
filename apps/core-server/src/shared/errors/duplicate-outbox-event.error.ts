import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class DuplicateOutboxEventError extends BaseError {
  readonly name = 'DuplicateOutboxEventError'
  readonly status = StatusError.CONFLICT

  constructor(input: { eventId: string }) {
    super({ message: `An outbox message for event "${input.eventId}" was already enqueued.` })
  }
}
