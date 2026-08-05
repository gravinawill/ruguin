import { BaseError, StatusError } from '@ruguin/shared-domain'

export class InvalidSentEmailCorrelationError extends BaseError {
  readonly name = 'InvalidSentEmailCorrelationError'
  readonly status = StatusError.INVALID_INPUT

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- required to create public constructor for this subclass
  constructor(input: { message: string; error?: unknown }) {
    super(input)
  }
}
