import { BaseError, StatusError } from '@ruguin/shared-domain'

export class CacheTimeoutError extends BaseError {
  readonly name = 'CacheTimeoutError'
  readonly status = StatusError.INTERNAL_ERROR

  constructor(input: { operation: string; timeoutInMs: number }) {
    super({ message: `Cache operation "${input.operation}" exceeded ${input.timeoutInMs}ms` })
  }
}
