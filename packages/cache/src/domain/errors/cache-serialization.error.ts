import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class CacheSerializationError extends BaseError {
  readonly name = 'CacheSerializationError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { operation: string; error?: unknown }) {
    super({ message: `Cache serialization failed during "${input.operation}"`, error: input.error })
  }
}
