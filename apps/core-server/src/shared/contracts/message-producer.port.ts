import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either } from '@ruguin/utils'

export const MESSAGE_PRODUCER_PORT = Symbol('MESSAGE_PRODUCER_PORT')

export type OutboundMessage = {
  topic: string
  key: string
  message: { eventId: string; name: string; payload: unknown }
}

export interface MessageProducerPort {
  publish(input: OutboundMessage): Promise<Either<BaseError, void>>
}
