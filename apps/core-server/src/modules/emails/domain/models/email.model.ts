import { type ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidEmailError } from '../errors/models/invalid-email.error'

export class Email {
  private constructor(
    readonly id: ID,
    readonly projectId: string,
    readonly templateId: string | null,
    readonly idempotencyKey: string | null,
    readonly from: string,
    readonly to: string,
    readonly subject: string,
    readonly html: string,
    readonly createdAt: Date
  ) {
    Object.freeze(this)
  }

  public static create(input: {
    id: ID
    projectId: string
    templateId: string | null
    idempotencyKey: string | null
    from: string
    to: string
    subject: string
    html: string
    createdAt: Date
  }): Either<InvalidEmailError, Email> {
    if (input.projectId.trim().length === 0) return failure(new InvalidEmailError({ reason: 'projectId is empty' }))
    if (input.from.trim().length === 0) return failure(new InvalidEmailError({ reason: '"from" is empty' }))
    if (input.to.trim().length === 0) return failure(new InvalidEmailError({ reason: '"to" is empty' }))
    if (input.subject.trim().length === 0) return failure(new InvalidEmailError({ reason: 'subject is empty' }))
    if (input.html.trim().length === 0) return failure(new InvalidEmailError({ reason: 'html is empty' }))

    return success(
      new Email(
        input.id,
        input.projectId,
        input.templateId,
        input.idempotencyKey,
        input.from,
        input.to,
        input.subject,
        input.html,
        input.createdAt
      )
    )
  }
}
