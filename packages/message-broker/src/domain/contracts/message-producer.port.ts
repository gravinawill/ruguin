import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

export const MESSAGE_PRODUCER_PORT = Symbol('MESSAGE_PRODUCER_PORT')

export type OutboundMessage = Readonly<{
  topic: string
  key: string
  message: Readonly<{ eventId: string; name: string; payload: unknown }>
  headers?: Readonly<Record<string, string>>
}>

export interface MessageProducerPort {
  publish(input: OutboundMessage): Promise<Either<BaseError, void>>
}
