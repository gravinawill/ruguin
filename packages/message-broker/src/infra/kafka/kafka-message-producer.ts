import { Injectable, type OnModuleDestroy } from '@nestjs/common'
import { type Producer } from '@platformatic/kafka'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { type MessageProducerPort, type OutboundMessage } from '../../domain/contracts/message-producer.port.ts'
import { MessagePublishError } from '../../domain/errors/message-publish.error.ts'

@Injectable()
export class KafkaMessageProducer implements MessageProducerPort, OnModuleDestroy {
  constructor(private readonly producer: Producer<string, string, string, string>) {}

  public async publish(input: OutboundMessage): Promise<Either<BaseError, void>> {
    try {
      await this.producer.send({
        messages: [
          {
            topic: input.topic,
            key: input.key,
            value: JSON.stringify(input.message),
            ...(input.headers !== undefined && { headers: input.headers })
          }
        ]
      })

      return success(undefined)
    } catch (error: unknown) {
      return failure(new MessagePublishError({ error, message: `Failed to publish to topic "${input.topic}".` }))
    }
  }

  public async onModuleDestroy(): Promise<void> {
    await this.producer.close()
  }
}
