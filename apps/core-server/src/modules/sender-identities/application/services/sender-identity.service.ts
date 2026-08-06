import { Injectable } from '@nestjs/common'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

import { type SenderIdentity } from '../../domain/models/sender-identity.model'
import { ListSenderIdentitiesUseCase } from '../use-cases/list-sender-identities.use-case'
import {
  RegisterSenderIdentityUseCase,
  type RegisterSenderIdentityUseCaseInput
} from '../use-cases/register-sender-identity.use-case'

/*
 * Forwards only — no branching, no repository access. Same deliberate shape as
 * emails/application/services/send-email.service.ts: keeps the controller's signature uniform and
 * is where a future cross-cutting concern attaches without touching the use cases.
 */
@Injectable()
export class SenderIdentityService {
  constructor(
    private readonly registerUseCase: RegisterSenderIdentityUseCase,
    private readonly listUseCase: ListSenderIdentitiesUseCase
  ) {}

  public register(input: RegisterSenderIdentityUseCaseInput): Promise<Either<BaseError, SenderIdentity>> {
    return this.registerUseCase.execute(input)
  }

  public list(input: { projectId: string }): Promise<Either<BaseError, SenderIdentity[]>> {
    return this.listUseCase.execute(input)
  }
}
