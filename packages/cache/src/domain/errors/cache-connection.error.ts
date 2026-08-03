import { BaseError, StatusError } from '@ruguin/shared-domain'

export class CacheConnectionError extends BaseError {
  readonly name = 'CacheConnectionError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { operation: string; error?: unknown }) {
    super({ message: `Cache connection failed during "${input.operation}"`, error: input.error })
  }
}
