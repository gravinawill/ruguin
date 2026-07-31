import { BaseError, StatusError } from '@ruguin/ddd-kernel'

export class LockNotAcquiredError extends BaseError {
  readonly name = 'LockNotAcquiredError'
  readonly status = StatusError.CONFLICT

  constructor(input: { lockKey: string; attempts: number }) {
    super({ message: `Lock "${input.lockKey}" not acquired after ${input.attempts} attempt(s)` })
  }
}
