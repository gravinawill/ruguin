import { SES_NOTIFICATION_CORRELATION_DLQ_TOPIC, SES_NOTIFICATION_MALFORMED_DLQ_TOPIC } from '@ruguin/event-schemas'
import { type MessageProducerPort } from '@ruguin/message-broker'
import { success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { publishExhaustedCorrelationToDlq, publishMalformedNotificationToDlq } from '../dlq-routing.ts'

describe('publishMalformedNotificationToDlq', () => {
  it('publishes the raw body and reason to the malformed DLQ topic', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const producer = { publish } as unknown as MessageProducerPort

    await publishMalformedNotificationToDlq(producer, { rawBody: { some: 'body' }, reason: 'invalid envelope' })

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: SES_NOTIFICATION_MALFORMED_DLQ_TOPIC,
        key: expect.any(String),
        message: expect.objectContaining({
          name: 'ses.notification.malformed',
          payload: { rawBody: { some: 'body' }, reason: 'invalid envelope' }
        })
      })
    )
  })
})

describe('publishExhaustedCorrelationToDlq', () => {
  it('publishes to the correlation DLQ topic keyed by sesMessageId, with attempt in headers', async () => {
    const publish = vi.fn().mockResolvedValue(success(undefined))
    const producer = { publish } as unknown as MessageProducerPort

    await publishExhaustedCorrelationToDlq(producer, { sesMessageId: 'ses-msg-1', status: 'bounced', attempt: 6 })

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: SES_NOTIFICATION_CORRELATION_DLQ_TOPIC,
        key: 'ses-msg-1',
        headers: { attempt: '6' },
        message: expect.objectContaining({
          name: 'ses.notification.correlation.pending',
          payload: { sesMessageId: 'ses-msg-1', status: 'bounced' }
        })
      })
    )
  })
})
