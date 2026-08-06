import { BaseError, StatusError } from '@ruguin/shared-domain'

export class FindOrganizationError extends BaseError {
  readonly name = 'FindOrganizationError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { error?: unknown }) {
    super({ error: input.error, message: 'Failed to look up the organization.' })
  }
}
