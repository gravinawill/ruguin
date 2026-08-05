import { Inject, Injectable } from '@nestjs/common'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

import { CORRELATION_PROVIDER, type CorrelationPort } from '../providers/correlation.port.ts'

export type RecordSentCorrelationInput = Readonly<{ sesMessageId: string; emailId: string }>

@Injectable()
export class RecordSentCorrelationUseCase {
  constructor(@Inject(CORRELATION_PROVIDER) private readonly correlation: CorrelationPort) {}

  public execute(input: RecordSentCorrelationInput): Promise<Either<BaseError, void>> {
    return this.correlation.upsert(input)
  }
}
