import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class InvalidCacheKeyError extends BaseError {
  readonly name = 'InvalidCacheKeyError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { field: 'key' | 'namespace' | 'version'; value: string; reason: string }) {
    super({ message: `Invalid cache ${input.field} "${input.value}": ${input.reason}` })
  }
}
