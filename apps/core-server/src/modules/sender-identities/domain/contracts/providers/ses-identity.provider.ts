import { type Either } from '@ruguin/utils'

import { type CheckSesIdentityError } from '../../errors/check-ses-identity.error'
import { type CreateSesIdentityError } from '../../errors/create-ses-identity.error'

export const SES_IDENTITY_PROVIDER = Symbol('SES_IDENTITY_PROVIDER')

export interface SesIdentityProvider {
  createIdentity(input: { email: string }): Promise<Either<CreateSesIdentityError, void>>
  getVerificationStatus(input: { email: string }): Promise<Either<CheckSesIdentityError, { verified: boolean }>>
}
