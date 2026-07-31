import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class CacheNotInitializedError extends BaseError {
  readonly name = 'CacheNotInitializedError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { operation: string }) {
    super({ message: `Cache used before connect() during "${input.operation}"` })
  }
}
