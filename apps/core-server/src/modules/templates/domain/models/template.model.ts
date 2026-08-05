import { type ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidTemplateError } from '../errors/invalid-template.error'

export class Template {
  private constructor(
    readonly id: ID,
    readonly projectId: string,
    readonly name: string,
    readonly subject: string,
    readonly html: string,
    readonly createdAt: Date
  ) {
    Object.freeze(this)
  }

  public static create(input: {
    id: ID
    projectId: string
    name: string
    subject: string
    html: string
    createdAt: Date
  }): Either<InvalidTemplateError, Template> {
    if (input.subject.trim().length === 0) return failure(new InvalidTemplateError({ reason: 'subject is empty' }))
    if (input.html.trim().length === 0) return failure(new InvalidTemplateError({ reason: 'html is empty' }))

    return success(new Template(input.id, input.projectId, input.name, input.subject, input.html, input.createdAt))
  }
}
