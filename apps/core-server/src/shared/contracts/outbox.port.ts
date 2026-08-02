import { type Event } from '@ruguin/ddd-kernel'
import { type Either } from '@ruguin/utils'

import { type EnqueueOutboxMessageError } from '../errors/enqueue-outbox-message.error'

import { type TransactionContext } from './transaction-context.contract'

export const OUTBOX_PORT = Symbol('OUTBOX_PORT')

export interface OutboxPort {
  enqueue<TPayload>(
    event: Event<TPayload>,
    options: { topic: string; key: string },
    tx: TransactionContext
  ): Promise<Either<EnqueueOutboxMessageError, void>>
}
