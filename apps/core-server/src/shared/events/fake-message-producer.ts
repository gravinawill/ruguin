import { Injectable, Logger } from '@nestjs/common'
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either, success } from '@ruguin/utils'

import { type MessageProducerPort, type OutboundMessage } from '../contracts/message-producer.port'

const MAX_RECORDED_MESSAGES = 10_000

@Injectable()
export class FakeMessageProducer implements MessageProducerPort {
  private readonly logger = new Logger(FakeMessageProducer.name)
  private readonly published: OutboundMessage[] = []

  constructor() {
    this.logger.warn(
      'OutboxModule is bound to FakeMessageProducer — published messages are recorded in memory ' +
        'only and are NOT delivered anywhere. Replace MESSAGE_PRODUCER_PORT with a real producer ' +
        'before relying on outbox delivery.'
    )
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- Satisfies async interface contract; fake impl has nothing to await
  public async publish(input: OutboundMessage): Promise<Either<BaseError, void>> {
    if (this.published.length >= MAX_RECORDED_MESSAGES) this.published.shift()

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
