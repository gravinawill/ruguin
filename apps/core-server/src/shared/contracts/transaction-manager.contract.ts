import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either } from '@ruguin/utils'

import { type TransactionContext } from './transaction-context.contract'

export const TRANSACTION_MANAGER = Symbol('TRANSACTION_MANAGER')

export interface TransactionManager {
  execute<E extends BaseError, T>(
    work: (tx: TransactionContext) => Promise<Either<E, T>>
  ): Promise<Either<BaseError | E, T>>
}
