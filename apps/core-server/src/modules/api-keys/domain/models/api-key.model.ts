import { type ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidApiKeyError } from '../errors/invalid-api-key.error'

export class ApiKey {
  private constructor(
    readonly id: ID,
    readonly projectId: string,
    readonly hashedKey: string,
    readonly revokedAt: Date | null,
    readonly createdAt: Date
  ) {
    Object.freeze(this)
  }

  public static create(input: {
    id: ID
    projectId: string
    hashedKey: string
    revokedAt: Date | null
    createdAt: Date
  }): Either<InvalidApiKeyError, ApiKey> {
    if (input.hashedKey.trim().length === 0) return failure(new InvalidApiKeyError({ reason: 'hashedKey is empty' }))
    if (input.projectId.trim().length === 0) return failure(new InvalidApiKeyError({ reason: 'projectId is empty' }))

    return success(new ApiKey(input.id, input.projectId, input.hashedKey, input.revokedAt, input.createdAt))
  }

  public isRevoked(): boolean {
    return this.revokedAt !== null
  }
}
