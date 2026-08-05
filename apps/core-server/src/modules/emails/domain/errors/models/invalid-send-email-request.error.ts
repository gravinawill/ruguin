import { BaseError, StatusError } from '@ruguin/shared-domain'
import { type z } from 'zod'

export class InvalidSendEmailRequestError extends BaseError {
  readonly name = 'InvalidSendEmailRequestError'
  readonly status = StatusError.INVALID_INPUT

  /*
   * `z.ZodIssue` is deprecated in zod 4 in favor of `z.core.$ZodIssue` — the classic export is kept
   * only for v3 compatibility. This error only ever receives issues from safeParse, so taking the
   * core type directly avoids the deprecated alias without needing the separate @zod/core package.
   */
  constructor(input: { issues: readonly z.core.$ZodIssue[] }) {
    super({
      error: input.issues,
      message: 'Request body must include either { templateId, variables } or { subject, html }.'
    })
  }
}
