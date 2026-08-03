import { BaseError, StatusError } from '@ruguin/shared-domain'

export class SesSendError extends BaseError {
  readonly name = 'SesSendError'
  readonly status = StatusError.INTERNAL_ERROR

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- required to create public constructor for this subclass
  constructor(input: { message: string; error?: unknown }) {
    super(input)
  }
}
