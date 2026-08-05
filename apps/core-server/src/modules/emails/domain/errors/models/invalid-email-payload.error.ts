import { BaseError, StatusError } from '@ruguin/shared-domain'

/*
 * Reaching this means a persisted Email (already validated by Email.create, from/to only checked
 * non-empty) doesn't satisfy EmailSendRequestedPayloadSchema's stricter contract (real z.email()
 * addresses, UUIDs). Task 12's DTO validates real email formats before this use case ever runs, so
 * this is a defensive backstop against an upstream gap, not expected user input — hence 500, not 422.
 */
export class InvalidEmailPayloadError extends BaseError {
  readonly name = 'InvalidEmailPayloadError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error: unknown }) {
    super({ error: input.error, message: 'The email does not satisfy the email.send.requested payload contract.' })
  }
}
