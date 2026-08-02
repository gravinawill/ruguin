import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class MessagePublishError extends BaseError {
  readonly name = 'MessagePublishError'
  readonly status = StatusError.INTERNAL_ERROR

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- required to create public constructor for this subclass
  constructor(input: { message: string; error?: unknown }) {
    super(input)
  }
}
