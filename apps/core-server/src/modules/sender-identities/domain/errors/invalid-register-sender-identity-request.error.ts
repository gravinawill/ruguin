import { BaseError, StatusError } from '@ruguin/shared-domain'
import { type z } from 'zod'

export class InvalidRegisterSenderIdentityRequestError extends BaseError {
  readonly name = 'InvalidRegisterSenderIdentityRequestError'
  readonly status = StatusError.INVALID_INPUT

  constructor(input: { issues: readonly z.core.$ZodIssue[] }) {
    super({ error: input.issues, message: 'Request body must include { name, email }.' })
  }
}
