import { Injectable } from '@nestjs/common'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { type TransactionContext } from '../../../domain/contracts/transaction-context.contract'
import { type TransactionManager } from '../../../domain/contracts/transaction-manager.contract'
import { TransactionError } from '../../../domain/errors/transaction.error'

import { PrismaService } from './prisma.service'

class RollbackSignal extends Error {
  readonly originalError: BaseError

  constructor(originalError: BaseError) {
    super('Rollback requested by a Failure returned inside the transaction.')
    this.name = 'RollbackSignal'
    this.originalError = originalError
  }
}

@Injectable()
export class PrismaTransactionManager implements TransactionManager {
  constructor(private readonly prisma: PrismaService) {}

  public async execute<E extends BaseError, T>(
    work: (tx: TransactionContext) => Promise<Either<E, T>>
  ): Promise<Either<BaseError | E, T>> {
    try {
      const value = await this.prisma.$transaction(async (tx): Promise<T> => {
        const result = await work(tx as unknown as TransactionContext)

        if (result.isFailure()) throw new RollbackSignal(result.value)

        return result.value
      })

      return success(value)
    } catch (error: unknown) {
      if (error instanceof RollbackSignal) return failure(error.originalError as E)

      return failure(new TransactionError({ error }))
    }
  }
}
