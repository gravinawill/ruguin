import { type Either } from '@ruguin/utils'

import { type FindSenderIdentityError } from '../errors/find-sender-identity.error'
import { type SenderIdentity } from '../models/sender-identity.model'

export const SENDER_IDENTITY_CACHE_PROVIDER = Symbol('SENDER_IDENTITY_CACHE_PROVIDER')

export interface SenderIdentityCacheProvider {
  get(input: { senderIdentityId: string }): Promise<Either<FindSenderIdentityError, SenderIdentity | null>>
  invalidate(input: { senderIdentityId: string }): Promise<void>
}
