import { describe, expect, it } from 'vitest'

import {
  EMAIL_ENGAGEMENT_DLQ_TOPIC,
  EMAIL_ENGAGEMENT_TOPIC,
  EmailEngagementPayloadSchema
} from '../email-engagement.schema.ts'

describe('EmailEngagementPayloadSchema', () => {
  it('accepts a valid "open" event', () => {
    const result = EmailEngagementPayloadSchema.safeParse({
      emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
      type: 'open',
      occurredAt: '2026-08-02T12:00:00.000Z'
    })

    expect(result.success).toBe(true)
  })

  it('rejects a type outside open/click', () => {
    const result = EmailEngagementPayloadSchema.safeParse({
      emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
      type: 'unsubscribe',
      occurredAt: '2026-08-02T12:00:00.000Z'
    })

    expect(result.success).toBe(false)
  })

  it('exposes the main and DLQ topic constants', () => {
    expect(EMAIL_ENGAGEMENT_TOPIC).toBe('email.engagement')
    expect(EMAIL_ENGAGEMENT_DLQ_TOPIC).toBe('email.engagement.dlq')
  })
})
