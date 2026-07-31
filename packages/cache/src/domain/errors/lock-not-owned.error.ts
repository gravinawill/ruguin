import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class LockNotOwnedError extends BaseError {
  readonly name = 'LockNotOwnedError'
  readonly status = StatusError.CONFLICT

  constructor(input: { lockKey: string }) {
    super({ message: `Lock "${input.lockKey}" is held by another owner or already expired` })
  }
}
