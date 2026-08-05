import { type Either } from '@ruguin/utils'

import { type TransactionContext } from '../../../../../shared/domain/contracts/transaction-context.contract'
import { type CreateEmailError } from '../../errors/models/create-email.error'
import { type EmailIdempotencyConflictError } from '../../errors/models/email-idempotency-conflict.error'
import { type Email } from '../../models/email.model'

export const EMAIL_REPOSITORY = Symbol('EMAIL_REPOSITORY')

export interface EmailRepository {
  createIfNotExists(input: {
    email: Email
    tx: TransactionContext
  }): Promise<Either<CreateEmailError | EmailIdempotencyConflictError, { email: Email; created: boolean }>>
}
