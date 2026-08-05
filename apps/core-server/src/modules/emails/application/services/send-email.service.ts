import { Injectable } from '@nestjs/common'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

import { type Email } from '../../domain/models/email.model'
import { SendEmailUseCase, type SendEmailUseCaseInput } from '../use-cases/send-email.use-case'

/*
 * Forwards only — no branching, no repository access. Deliberate per CLAUDE.md: the controller's
 * signature stays uniform, and this is where a future cross-cutting concern (metrics, auditing)
 * attaches without touching the use case. Do not delete because it "does nothing" — that is the job.
 */
@Injectable()
export class SendEmailService {
  constructor(private readonly sendEmailUseCase: SendEmailUseCase) {}

  public execute(input: SendEmailUseCaseInput): Promise<Either<BaseError, Email>> {
    return this.sendEmailUseCase.execute(input)
  }
}
