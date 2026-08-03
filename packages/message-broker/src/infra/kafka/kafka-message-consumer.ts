import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import { type Consumer } from '@platformatic/kafka'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import {
  type InboundMessage,
  type MessageConsumerPort,
  type MessageHandler,
  type SubscribeInput
} from '../../domain/contracts/message-consumer.port.ts'
import { MessageConsumeError } from '../../domain/errors/message-consume.error.ts'

export type CreateConsumer = (groupId: string) => Consumer<string, string, string, string>

/*
 * commit() mirrors @platformatic/kafka's own Message.commit(callback?): void | Promise<void>
 * rather than narrowing to Promise<void> — the union is what the library declares, so narrowing it
 * here makes the real MessagesStream fail to satisfy this type. The promise half is the one that
 * materializes for us: see the await in forwardMessages().
 */
type ConsumedMessage = Readonly<{
  value: string
  headers: Map<string, string>
  commit(callback?: (error?: Error) => void): void | Promise<void>
}>

function decodeHeaders(headers: Map<string, string> | undefined): Record<string, string> {
  if (headers === undefined) return {}

  return Object.fromEntries(headers)
}

@Injectable()
export class KafkaMessageConsumer implements MessageConsumerPort, OnModuleDestroy {
  private readonly logger = new Logger(KafkaMessageConsumer.name)
  private readonly consumers: Array<Consumer<string, string, string, string>> = []

  constructor(private readonly createConsumer: CreateConsumer) {}

  public async subscribe(input: SubscribeInput): Promise<Either<BaseError, void>> {
    try {
      const consumer = this.createConsumer(input.groupId)
      this.consumers.push(consumer)

      const stream = await consumer.consume({ topics: [input.topic] })

      void this.forwardMessages(stream, input.onMessage)

      return success(undefined)
    } catch (error: unknown) {
      return failure(
        new MessageConsumeError({
          error,
          message: `Failed to subscribe to topic "${input.topic}" (group "${input.groupId}").`
        })
      )
    }
  }

  /*
   * force: true is required, not optional cleanup — forwardMessages() keeps every stream open
   * indefinitely (it only ends when the broker connection drops), so at shutdown time every
   * tracked consumer still has an open stream. @platformatic/kafka's close(false) (the default)
   * refuses outright with "Cannot leave group while consuming messages." when a stream is still
   * open; close(true) closes the open streams first and then completes the leave-group handshake
   * — confirmed against the real broker, not just the mocked unit test below.
   *
   * close() is overloaded — close(force: boolean, callback?): void vs. close(force?: boolean):
   * Promise<void> — and calling close(true) with no callback resolves to the *first* (void)
   * overload, not the promise-returning one, so it must be wrapped explicitly rather than awaited
   * directly.
   */
  private static closeConsumer(consumer: Consumer<string, string, string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      consumer.close(true, (error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }

  public async onModuleDestroy(): Promise<void> {
    await Promise.all(this.consumers.map((consumer) => KafkaMessageConsumer.closeConsumer(consumer)))
  }

  /*
   * Runs detached from subscribe() for the lifetime of the consumer, so a single bad message
   * (malformed JSON, or onMessage rejecting/throwing) must never escape this loop uncaught — an
   * unhandled rejection here would crash the whole process under Node's default behavior, taking
   * down every other topic this worker consumes along with it.
   *
   * The consumer is constructed with autocommit: false (message-broker.module.ts) so this method
   * decides when a commit is safe: only after onMessage() resolves successfully, never on a
   * malformed message or a handler failure. This closes the crash-window bug that made delivery
   * at-most-once: @platformatic/kafka's own autocommit stages the offset the moment a fetched
   * batch reaches the stream, before the application has handled it, so a crash between fetch and
   * processing silently lost the message. Message.commit() called with no arguments returns a
   * real, awaitable Promise<void> at runtime (unlike Consumer.close(), this is not an
   * overload-ambiguity trap), so it's safe to await directly inside this same try/catch.
   *
   * Known residual gap: Kafka commits a per-partition watermark offset, not a per-message ack.
   * If message M1 on partition P fails (skipped, no commit) but a later message M2 on the same
   * partition P succeeds and commits, the committed offset advances past M1 — M1 will not be
   * redelivered on restart/rebalance even though it was never actually processed. A complete fix
   * would need to stop consuming a partition after a failure until that message is resolved,
   * which conflicts with this method's deliberate "one bad message must never stop the loop"
   * design (first paragraph above). Accepted for now; tracked as follow-up, not blocking this fix.
   */
  private async forwardMessages(stream: AsyncIterable<ConsumedMessage>, onMessage: MessageHandler): Promise<void> {
    for await (const message of stream) {
      try {
        const parsed = JSON.parse(message.value) as { eventId: string; name: string; payload: unknown }
        const inbound: InboundMessage = { ...parsed, headers: decodeHeaders(message.headers) }

        const result = await onMessage(inbound)

        if (result.isFailure()) {
          this.logger.error(`Message handler failed: ${result.value.message}`)
          continue
        }

        await message.commit()
      } catch (error: unknown) {
        this.logger.error(
          `Failed to process a consumed message: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }
}
