import { BaseError, StatusError } from '@ruguin/shared-domain'

export class InvalidSesNotificationEventError extends BaseError {
  readonly name = 'InvalidSesNotificationEventError'
  readonly status = StatusError.INVALID_INPUT

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- required to create public constructor for this subclass
  constructor(input: { message: string; error?: unknown }) {
    super(input)
  }
}
