import { type BaseError, type JsonValue } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

export const MESSAGE_PRODUCER_PORT = Symbol('MESSAGE_PRODUCER_PORT')

export type OutboundMessage = {
  topic: string
  key: string
  message: { eventId: string; name: string; payload: JsonValue }
}

export interface MessageProducerPort {
  publish(input: OutboundMessage): Promise<Either<BaseError, void>>
}
