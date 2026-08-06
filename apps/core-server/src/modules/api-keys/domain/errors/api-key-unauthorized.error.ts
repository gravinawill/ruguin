import { BaseError, StatusError } from '@ruguin/shared-domain'

export class ApiKeyUnauthorizedError extends BaseError {
  readonly name = 'ApiKeyUnauthorizedError'
  readonly status = StatusError.UNAUTHORIZED

  constructor(input: { reason: string }) {
    super({ message: `${input.reason}.` })
  }
}
