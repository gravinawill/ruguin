import { Injectable, Logger } from '@nestjs/common'
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
export class KafkaMessageConsumer implements MessageConsumerPort {
  private readonly logger = new Logger(KafkaMessageConsumer.name)

  constructor(private readonly createConsumer: CreateConsumer) {}

  public async subscribe(input: SubscribeInput): Promise<Either<BaseError, void>> {
    try {
      const consumer = this.createConsumer(input.groupId)
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
          this.logger.error(
            `Failed to handle message "${inbound.eventId}": ${result.value.message}`,
            result.value.error
          )
        }
      } catch (error: unknown) {
        // A single malformed message or a throwing handler must not crash this detached loop and take every topic with it.
        this.logger.error('Failed to process a message from the consumer stream.', error)
      }
    }
  }
}
