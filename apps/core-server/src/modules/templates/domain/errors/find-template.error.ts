import { BaseError, StatusError } from '@ruguin/shared-domain'

export class FindTemplateError extends BaseError {
  readonly name = 'FindTemplateError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to look up the template.' })
  }
}
