import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either } from '@ruguin/utils'

export const MESSAGE_CONSUMER_PORT = Symbol('MESSAGE_CONSUMER_PORT')

export type InboundMessage = Readonly<{
  eventId: string
  name: string
  payload: unknown
  headers: Readonly<Record<string, string>>
}>

export type MessageHandler = (message: InboundMessage) => Promise<Either<BaseError, void>>

export type SubscribeInput = Readonly<{
  topic: string
  groupId: string
  onMessage: MessageHandler
}>

export interface MessageConsumerPort {
  subscribe(input: SubscribeInput): Promise<Either<BaseError, void>>
}
