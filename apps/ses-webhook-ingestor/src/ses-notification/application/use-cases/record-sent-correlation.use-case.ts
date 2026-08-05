import { Inject, Injectable } from '@nestjs/common'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

import { CORRELATION_PROVIDER, type CorrelationPort } from '../../domain/contracts/correlation.port.ts'
import { type SentEmailCorrelation } from '../../domain/models/sent-email-correlation.model.ts'

@Injectable()
export class RecordSentCorrelationUseCase {
  constructor(@Inject(CORRELATION_PROVIDER) private readonly correlation: CorrelationPort) {}

  public execute(correlation: SentEmailCorrelation): Promise<Either<BaseError, void>> {
    return this.correlation.upsert({ sesMessageId: correlation.sesMessageId, emailId: correlation.emailId })
  }
}
