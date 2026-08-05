import { Injectable } from '@nestjs/common'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

/*
 * Value import, not `type` — PrismaService is a constructor parameter that Nest's DI resolves
 * by reflected design:paramtypes metadata. A type-only import erases the class reference at
 * compile time, so Nest sees an unresolvable `Object` token here (this repository's own unit
 * test never caught it because it constructs the class manually with `new`, bypassing DI).
 */
import { PrismaService } from '../../../shared/infrastructure/database/prisma/prisma.service.ts'
import {
  type CorrelationPort,
  type LookupCorrelationInput,
  type LookupCorrelationOutput,
  type UpsertCorrelationInput
} from '../../domain/contracts/correlation.port.ts'
import { CorrelationLookupError } from '../../domain/errors/correlation-lookup.error.ts'
import { CorrelationUpsertError } from '../../domain/errors/correlation-upsert.error.ts'

@Injectable()
export class PrismaCorrelationRepository implements CorrelationPort {
  constructor(private readonly prisma: PrismaService) {}

  public async upsert(input: UpsertCorrelationInput): Promise<Either<BaseError, void>> {
    try {
      await this.prisma.sesMessageCorrelation.upsert({
        where: { sesMessageId: input.sesMessageId },
        create: { sesMessageId: input.sesMessageId, emailId: input.emailId },
        /*
         * A conflict means this sesMessageId was already recorded — the row's emailId doesn't
         * change for a given SES message id, so there is nothing new to write on conflict.
         */
        update: {}
      })

      return success(undefined)
    } catch (error: unknown) {
      return failure(
        new CorrelationUpsertError({
          error,
          message: `Failed to upsert correlation for sesMessageId "${input.sesMessageId}".`
        })
      )
    }
  }

  public async lookup(input: LookupCorrelationInput): Promise<Either<BaseError, LookupCorrelationOutput>> {
    try {
      const found = await this.prisma.sesMessageCorrelation.findUnique({ where: { sesMessageId: input.sesMessageId } })

      return success(found === null ? null : { emailId: found.emailId })
    } catch (error: unknown) {
      return failure(
        new CorrelationLookupError({
          error,
          message: `Failed to look up correlation for sesMessageId "${input.sesMessageId}".`
        })
      )
    }
  }
}
