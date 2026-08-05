import { BaseError, StatusError } from '@ruguin/shared-domain'

export class InvalidTemplateError extends BaseError {
  readonly name = 'InvalidTemplateError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { reason: string }) {
    super({ message: `Invalid template: ${input.reason}.` })
  }
}
