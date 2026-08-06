import { type ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidSenderIdentityError } from '../errors/invalid-sender-identity.error'

export class SenderIdentity {
  private constructor(
    readonly id: ID,
    readonly projectId: string,
    readonly name: string,
    readonly email: string,
    readonly verifiedAt: Date | null,
    readonly createdAt: Date
  ) {
    Object.freeze(this)
  }

  public static create(input: {
    id: ID
    projectId: string
    name: string
    email: string
    verifiedAt: Date | null
    createdAt: Date
  }): Either<InvalidSenderIdentityError, SenderIdentity> {
    if (input.projectId.trim().length === 0) {
      return failure(new InvalidSenderIdentityError({ reason: 'projectId is empty' }))
    }
    if (input.name.trim().length === 0) return failure(new InvalidSenderIdentityError({ reason: 'name is empty' }))
    if (input.email.trim().length === 0) return failure(new InvalidSenderIdentityError({ reason: 'email is empty' }))

    return success(
      new SenderIdentity(input.id, input.projectId, input.name, input.email, input.verifiedAt, input.createdAt)
    )
  }

  public isVerified(): boolean {
    return this.verifiedAt !== null
  }

  /*
   * Not persisted (design spec decision 1) — derived on demand so it can never drift from `email`.
   * Falls back to '' rather than throwing: domain-layer validation only requires `email` to be
   * non-empty, not a well-formed address (that's the DTO's z.email() at Task 8's HTTP boundary), so
   * a malformed value here must degrade gracefully, not crash a getter.
   */
  public get domain(): string {
    const parts = this.email.split('@')
    return parts[1] ?? ''
  }
}
