import { BaseError, StatusError } from '@ruguin/shared-domain'

export class FindProjectError extends BaseError {
  readonly name = 'FindProjectError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to look up the project.' })
  }
}
