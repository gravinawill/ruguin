import { type ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidProjectError } from '../errors/invalid-project.error'

export class Project {
  private constructor(
    readonly id: ID,
    readonly organizationId: string,
    readonly name: string,
    readonly createdAt: Date
  ) {
    Object.freeze(this)
  }

  public static create(input: {
    id: ID
    organizationId: string
    name: string
    createdAt: Date
  }): Either<InvalidProjectError, Project> {
    if (input.name.trim().length === 0) return failure(new InvalidProjectError({ reason: 'name is empty' }))
    if (input.organizationId.trim().length === 0) {
      return failure(new InvalidProjectError({ reason: 'organizationId is empty' }))
    }

    return success(new Project(input.id, input.organizationId, input.name, input.createdAt))
  }
}
