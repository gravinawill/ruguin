import { type ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidOrganizationError } from '../errors/invalid-organization.error'

export class Organization {
  private constructor(
    readonly id: ID,
    readonly name: string,
    readonly createdAt: Date
  ) {
    Object.freeze(this)
  }

  public static create(input: {
    id: ID
    name: string
    createdAt: Date
  }): Either<InvalidOrganizationError, Organization> {
    if (input.name.trim().length === 0) {
      return failure(new InvalidOrganizationError({ reason: 'name is empty' }))
    }

    return success(new Organization(input.id, input.name, input.createdAt))
  }
}
