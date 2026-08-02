import { Injectable } from '@nestjs/common'
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either, success } from '@ruguin/utils'

import { type MessageProducerPort, type OutboundMessage } from '../contracts/message-producer.port'

@Injectable()
export class FakeMessageProducer implements MessageProducerPort {
  private readonly published: OutboundMessage[] = []

  public publish(input: OutboundMessage): Promise<Either<BaseError, void>> {
    this.published.push(input)

    return success(undefined)
  }

  public getPublished(): readonly OutboundMessage[] {
    return this.published
  }

  public clear(): void {
    this.published.length = 0
  }
}
