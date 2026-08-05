import { randomUUID } from 'node:crypto'

import { SES_NOTIFICATION_CORRELATION_DLQ_TOPIC, SES_NOTIFICATION_MALFORMED_DLQ_TOPIC } from '@ruguin/event-schemas'
import { type MessageProducerPort } from '@ruguin/message-broker'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

/*
 * Keyed by a fresh random id, not anything from the body — a malformed payload can't be trusted
 * to carry any usable identifier (that's exactly why it's here).
 */
export function publishMalformedNotificationToDlq(
  producer: MessageProducerPort,
  input: { rawBody: unknown; reason: string }
): Promise<Either<BaseError, void>> {
  return producer.publish({
    topic: SES_NOTIFICATION_MALFORMED_DLQ_TOPIC,
    key: randomUUID(),
    message: {
      eventId: randomUUID(),
      name: 'ses.notification.malformed',
      payload: { rawBody: input.rawBody, reason: input.reason }
    }
  })
}

export type ExhaustedCorrelationInput = Readonly<{
  sesMessageId: string
  status: string
  bounceType?: string
  attempt: number
}>

export function publishExhaustedCorrelationToDlq(
  producer: MessageProducerPort,
  input: ExhaustedCorrelationInput
): Promise<Either<BaseError, void>> {
  const { attempt, ...payload } = input

  return producer.publish({
    topic: SES_NOTIFICATION_CORRELATION_DLQ_TOPIC,
    key: input.sesMessageId,
    message: { eventId: randomUUID(), name: 'ses.notification.correlation.pending', payload },
    headers: { attempt: String(attempt) }
  })
}
