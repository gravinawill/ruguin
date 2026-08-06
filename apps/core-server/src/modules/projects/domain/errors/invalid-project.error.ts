import { BaseError, StatusError } from '@ruguin/shared-domain'

export class InvalidProjectError extends BaseError {
  readonly name = 'InvalidProjectError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { reason: string }) {
    super({ message: `Invalid project: ${input.reason}.` })
  }
}
