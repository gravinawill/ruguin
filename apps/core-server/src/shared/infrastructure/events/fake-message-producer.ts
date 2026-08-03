import { Injectable } from '@nestjs/common'
import { type MessageProducerPort, type OutboundMessage } from '@ruguin/message-broker'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, success } from '@ruguin/utils'

const MAX_RECORDED_MESSAGES = 10_000

/*
 * Test-only double for OutboxRelayService's .int.ts suite — lets those tests assert publish
 * ordering (which message, in which sequence) without a live Kafka broker. Production wiring uses
 * @ruguin/message-broker's real KafkaMessageProducer, registered globally by AppModule; this class
 * is never bound in OutboxModule.
 */
@Injectable()
export class FakeMessageProducer implements MessageProducerPort {
  private readonly published: OutboundMessage[] = []

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
