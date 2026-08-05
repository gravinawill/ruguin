import { Inject, Injectable } from '@nestjs/common'
import { type BaseError, ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { SES_IDENTITY_PROVIDER, type SesIdentityProvider } from '../../domain/contracts/providers/ses-identity.provider'
import {
  SENDER_IDENTITY_REPOSITORY,
  type SenderIdentityRepository
} from '../../domain/contracts/repositories/sender-identity.repository'
import { SenderIdentity } from '../../domain/models/sender-identity.model'

export type RegisterSenderIdentityUseCaseInput = Readonly<{ projectId: string; name: string; email: string }>

@Injectable()
export class RegisterSenderIdentityUseCase {
  constructor(
    @Inject(SENDER_IDENTITY_REPOSITORY) private readonly repository: SenderIdentityRepository,
    @Inject(SES_IDENTITY_PROVIDER) private readonly sesIdentityProvider: SesIdentityProvider
  ) {}

  public async execute(input: RegisterSenderIdentityUseCaseInput): Promise<Either<BaseError, SenderIdentity>> {
    const idGenerated = ID.generate({ modelName: 'SenderIdentity' })
    if (idGenerated.isFailure()) {
      /*
       * Same posture as SendEmailUseCase: UUID generation itself failing is treated as a bug, not
       * an expected domain failure — there is no meaningful recovery for the caller here.
       */
      throw new Error(`Failed to generate an id for a new sender identity: ${idGenerated.value.message}`)
    }

    const senderIdentityResult = SenderIdentity.create({
      id: idGenerated.value.idGenerated,
      projectId: input.projectId,
      name: input.name,
      email: input.email,
      verifiedAt: null,
      createdAt: new Date()
    })
    if (senderIdentityResult.isFailure()) return senderIdentityResult

    const created = await this.repository.create({ senderIdentity: senderIdentityResult.value })
    if (created.isFailure()) return failure(created.value)

    /*
     * Registered before SES confirms: the row is what GET /sender-identities lists back and what
     * Task 7's sync job polls for. A failed CreateEmailIdentity call here leaves the row stuck at
     * verifiedAt: null forever (Task 7 only checks status, never retries creation) — an accepted
     * risk documented in the design spec, not silently swallowed here.
     */
    const sesResult = await this.sesIdentityProvider.createIdentity({ email: created.value.email })
    if (sesResult.isFailure()) return failure(sesResult.value)

    return success(created.value)
  }
}
