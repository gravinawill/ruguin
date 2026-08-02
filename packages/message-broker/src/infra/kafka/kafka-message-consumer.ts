import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import { type Consumer } from '@platformatic/kafka'
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either, failure, success } from '@ruguin/utils'

import {
  type InboundMessage,
  type MessageConsumerPort,
  type MessageHandler,
  type SubscribeInput
} from '../../domain/contracts/message-consumer.port.ts'
import { MessageConsumeError } from '../../domain/errors/message-consume.error.ts'

export type CreateConsumer = (groupId: string) => Consumer<string, string, string, string>

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
   */
  private async forwardMessages(
    stream: AsyncIterable<{ value: string; headers: Map<string, string> }>,
    onMessage: MessageHandler
  ): Promise<void> {
    for await (const message of stream) {
      try {
        const parsed = JSON.parse(message.value) as { eventId: string; name: string; payload: unknown }
        const inbound: InboundMessage = { ...parsed, headers: decodeHeaders(message.headers) }

        const result = await onMessage(inbound)

        if (result.isFailure()) {
          this.logger.error(`Message handler failed: ${result.value.message}`)
        }
      } catch (error: unknown) {
        this.logger.error(
          `Failed to process a consumed message: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }
}
