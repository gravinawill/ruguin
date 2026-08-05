import { type Either } from '@ruguin/utils'

import { type CreateSenderIdentityError } from '../../errors/create-sender-identity.error'
import { type DuplicateSenderIdentityEmailError } from '../../errors/duplicate-sender-identity-email.error'
import { type FindSenderIdentityError } from '../../errors/find-sender-identity.error'
import { type SenderIdentity } from '../../models/sender-identity.model'

export const SENDER_IDENTITY_REPOSITORY = Symbol('SENDER_IDENTITY_REPOSITORY')

export interface SenderIdentityRepository {
  create(input: {
    senderIdentity: SenderIdentity
  }): Promise<Either<CreateSenderIdentityError | DuplicateSenderIdentityEmailError, SenderIdentity>>

  findById(input: { id: string }): Promise<Either<FindSenderIdentityError, { senderIdentity: SenderIdentity | null }>>

  findManyByProjectId(input: {
    projectId: string
  }): Promise<Either<FindSenderIdentityError, { senderIdentities: SenderIdentity[] }>>

  findUnverified(): Promise<Either<FindSenderIdentityError, { senderIdentities: SenderIdentity[] }>>

  markVerified(input: { id: string; verifiedAt: Date }): Promise<Either<FindSenderIdentityError, void>>
}
