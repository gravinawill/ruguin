import { BaseError, StatusError } from '@ruguin/shared-domain'

export class MessageConsumeError extends BaseError {
  readonly name = 'MessageConsumeError'
  readonly status = StatusError.INTERNAL_ERROR

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- required to create public constructor for this subclass
  constructor(input: { message: string; error?: unknown }) {
    super(input)
  }
}
