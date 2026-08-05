import { BaseError, StatusError } from '@ruguin/shared-domain'

export class InvalidApiKeyError extends BaseError {
  readonly name = 'InvalidApiKeyError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { reason: string }) {
    super({ message: `Invalid API key record: ${input.reason}.` })
  }
}
