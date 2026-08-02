import { type Event } from '@ruguin/ddd-kernel'
import { type Either, failure, success } from '@ruguin/utils'

import { type Prisma } from '../../generated/prisma/client'
import { type OutboxPort } from '../contracts/outbox.port'
import { type TransactionContext } from '../contracts/transaction-context.contract'
import { DuplicateOutboxEventError } from '../errors/duplicate-outbox-event.error'
import { EnqueueOutboxMessageError } from '../errors/enqueue-outbox-message.error'

const UNIQUE_CONSTRAINT_VIOLATION_CODE = 'P2002'

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === UNIQUE_CONSTRAINT_VIOLATION_CODE
  )
}

export class OutboxRepository implements OutboxPort {
  constructor(private readonly module: string) {}

  public async enqueue<TPayload>(
    event: Event<TPayload>,
    options: { topic: string; key: string },
    tx: TransactionContext
  ): Promise<Either<DuplicateOutboxEventError | EnqueueOutboxMessageError, void>> {
    const client = tx as unknown as Prisma.TransactionClient

    try {
      await client.outboxMessage.create({
        data: {
          eventId: event.id.toString(),
          key: options.key,
          module: this.module,
          name: event.name,
          payload: event.payload as Prisma.InputJsonValue,
          topic: options.topic
        }
      })

      return success(undefined)
    } catch (error: unknown) {
      if (isUniqueConstraintViolation(error)) {
        return failure(new DuplicateOutboxEventError({ eventId: event.id.toString() }))
      }

      return failure(new EnqueueOutboxMessageError({ error }))
    }
  }
}
