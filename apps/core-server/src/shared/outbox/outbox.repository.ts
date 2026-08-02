import { type Event, type JsonValue } from '@ruguin/ddd-kernel'
import { type Either, failure, success } from '@ruguin/utils'

import { type Prisma } from '../../generated/prisma/client'
import { type OutboxPort } from '../contracts/outbox.port'
import { type TransactionContext } from '../contracts/transaction-context.contract'
import { EnqueueOutboxMessageError } from '../errors/enqueue-outbox-message.error'

export class OutboxRepository implements OutboxPort {
  constructor(private readonly module: string) {}

  public async enqueue<TPayload extends JsonValue>(
    event: Event<TPayload>,
    options: { topic: string; key: string },
    tx: TransactionContext
  ): Promise<Either<EnqueueOutboxMessageError, void>> {
    const client = tx as unknown as Prisma.TransactionClient

    try {
      await client.outboxMessage.create({
        data: {
          /*
           * (eventId, createdAt) backs consumer-side dedup in the relay, not enqueue-time
           * duplicate prevention: createdAt defaults per insert, so two genuine duplicates
           * land on different partitions and both succeed.
           */
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
      return failure(new EnqueueOutboxMessageError({ error }))
    }
  }
}
