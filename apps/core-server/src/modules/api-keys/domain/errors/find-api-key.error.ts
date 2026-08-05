import { BaseError, StatusError } from '@ruguin/shared-domain'

export class FindApiKeyError extends BaseError {
  readonly name = 'FindApiKeyError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to look up the API key.' })
  }
}
