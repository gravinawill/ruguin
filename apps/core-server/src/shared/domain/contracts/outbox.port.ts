import { type Event, type JsonValue } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

import { type EnqueueOutboxMessageError } from '../errors/enqueue-outbox-message.error'

import { type TransactionContext } from './transaction-context.contract'

export const OUTBOX_PORT = Symbol('OUTBOX_PORT')

export interface OutboxPort {
  enqueue<TPayload extends JsonValue>(
    event: Event<TPayload>,
    options: { topic: string; key: string },
    tx: TransactionContext
  ): Promise<Either<EnqueueOutboxMessageError, void>>
}
