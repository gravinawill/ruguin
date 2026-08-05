import { BaseError, StatusError } from '@ruguin/shared-domain'

export class InvalidOrganizationError extends BaseError {
  readonly name = 'InvalidOrganizationError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { reason: string }) {
    super({ message: `Invalid organization: ${input.reason}.` })
  }
}
