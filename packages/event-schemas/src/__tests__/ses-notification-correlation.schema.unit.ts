import { describe, expect, it } from 'vitest'

import {
  SES_NOTIFICATION_CORRELATION_DLQ_TOPIC,
  SES_NOTIFICATION_CORRELATION_RETRY_TOPIC,
  SES_NOTIFICATION_MALFORMED_DLQ_TOPIC,
  SesNotificationCorrelationPendingPayloadSchema
} from '../ses-notification-correlation.schema.ts'

describe('SesNotificationCorrelationPendingPayloadSchema', () => {
  it('accepts a delivered notification with no bounceType', () => {
    const result = SesNotificationCorrelationPendingPayloadSchema.safeParse({
      sesMessageId: 'ses-msg-1',
      status: 'delivered'
    })

    expect(result.success).toBe(true)
  })

  it('accepts a bounced notification with bounceType', () => {
    const result = SesNotificationCorrelationPendingPayloadSchema.safeParse({
      sesMessageId: 'ses-msg-1',
      status: 'bounced',
      bounceType: 'Transient'
    })

    expect(result.success).toBe(true)
  })

  it('rejects a status outside delivered/bounced/complained', () => {
    const result = SesNotificationCorrelationPendingPayloadSchema.safeParse({
      sesMessageId: 'ses-msg-1',
      status: 'sent'
    })

    expect(result.success).toBe(false)
  })

  it('rejects an empty sesMessageId', () => {
    const result = SesNotificationCorrelationPendingPayloadSchema.safeParse({
      sesMessageId: '',
      status: 'delivered'
    })

    expect(result.success).toBe(false)
  })

  it('exposes the retry, correlation DLQ, and malformed DLQ topic constants', () => {
    expect(SES_NOTIFICATION_CORRELATION_RETRY_TOPIC).toBe('ses.notification.correlation.retry')
    expect(SES_NOTIFICATION_CORRELATION_DLQ_TOPIC).toBe('ses.notification.correlation.dlq')
    expect(SES_NOTIFICATION_MALFORMED_DLQ_TOPIC).toBe('ses.notification.malformed.dlq')
  })

  it('rejects a "delivered" status with a bounceType', () => {
    const result = SesNotificationCorrelationPendingPayloadSchema.safeParse({
      sesMessageId: 'ses-msg-1',
      status: 'delivered',
      bounceType: 'Permanent'
    })

    expect(result.success).toBe(false)
  })

  it('rejects a "complained" status with a bounceType', () => {
    const result = SesNotificationCorrelationPendingPayloadSchema.safeParse({
      sesMessageId: 'ses-msg-1',
      status: 'complained',
      bounceType: 'Permanent'
    })

    expect(result.success).toBe(false)
  })
})
