import { Inject, Injectable } from '@nestjs/common'
import { type Either, failure, success } from '@ruguin/utils'

import {
  SENDER_IDENTITY_REPOSITORY,
  type SenderIdentityRepository
} from '../../domain/contracts/repositories/sender-identity.repository'
import { type FindSenderIdentityError } from '../../domain/errors/find-sender-identity.error'
import { type SenderIdentity } from '../../domain/models/sender-identity.model'

export type ListSenderIdentitiesUseCaseInput = Readonly<{ projectId: string }>

@Injectable()
export class ListSenderIdentitiesUseCase {
  constructor(@Inject(SENDER_IDENTITY_REPOSITORY) private readonly repository: SenderIdentityRepository) {}

  public async execute(
    input: ListSenderIdentitiesUseCaseInput
  ): Promise<Either<FindSenderIdentityError, SenderIdentity[]>> {
    const result = await this.repository.findManyByProjectId({ projectId: input.projectId })
    if (result.isFailure()) return failure(result.value)

    return success(result.value.senderIdentities)
  }
}
