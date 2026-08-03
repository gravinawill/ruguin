import { randomUUID } from 'node:crypto'

import { EMAIL_SEND_REQUESTED_DLQ_TOPIC } from '@ruguin/event-schemas'
import { type InboundMessage, type MessageProducerPort } from '@ruguin/message-broker'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

/*
 * Shared by both the main and retry consumers so the DLQ key and envelope shape can't drift
 * between them — a schema-invalid payload can't be trusted to carry a usable emailId, so the DLQ
 * message is keyed by the inbound eventId (always present on InboundMessage) instead.
 * docs/product-spec.md §3.3/§4.2: malformed messages must reach the DLQ, never be silently
 * discarded.
 */
export function publishMalformedMessageToDlq(
  producer: MessageProducerPort,
  message: InboundMessage
): Promise<Either<BaseError, void>> {
  return producer.publish({
    topic: EMAIL_SEND_REQUESTED_DLQ_TOPIC,
    key: message.eventId,
    message: { eventId: randomUUID(), name: 'email.send.requested', payload: message.payload }
  })
}
