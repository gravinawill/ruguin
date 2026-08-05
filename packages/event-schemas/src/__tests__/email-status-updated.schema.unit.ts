import { describe, expect, it } from 'vitest'

import {
  EMAIL_STATUS_UPDATED_DLQ_TOPIC,
  EMAIL_STATUS_UPDATED_TOPIC,
  EmailStatusUpdatedPayloadSchema,
  SesBounceType
} from '../email-status-updated.schema.ts'

describe('EmailStatusUpdatedPayloadSchema', () => {
  it('accepts a "sent" status with a sesMessageId', () => {
    const result = EmailStatusUpdatedPayloadSchema.safeParse({
      emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
      status: 'sent',
      sesMessageId: 'ses-msg-1'
    })

    expect(result.success).toBe(true)
  })

  it('accepts a "failed" status with an errorMessage and no sesMessageId', () => {
    const result = EmailStatusUpdatedPayloadSchema.safeParse({
      emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
      status: 'failed',
      errorMessage: 'SES throttled the request'
    })

    expect(result.success).toBe(true)
  })

  it('rejects a status outside the allowed set', () => {
    const result = EmailStatusUpdatedPayloadSchema.safeParse({
      emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
      status: 'unknown'
    })

    expect(result.success).toBe(false)
  })

  it('exposes the main and DLQ topic constants', () => {
    expect(EMAIL_STATUS_UPDATED_TOPIC).toBe('email.status.updated')
    expect(EMAIL_STATUS_UPDATED_DLQ_TOPIC).toBe('email.status.updated.dlq')
  })

  it('accepts a "bounced" status with a bounceType', () => {
    const result = EmailStatusUpdatedPayloadSchema.safeParse({
      emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
      status: 'bounced',
      bounceType: 'Permanent'
    })

    expect(result.success).toBe(true)
  })

  it('rejects a bounceType outside Permanent/Transient/Undetermined', () => {
    const result = EmailStatusUpdatedPayloadSchema.safeParse({
      emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
      status: 'bounced',
      bounceType: 'Nonsense'
    })

    expect(result.success).toBe(false)
  })

  it('exposes SesBounceType', () => {
    expect(SesBounceType).toEqual({ PERMANENT: 'Permanent', TRANSIENT: 'Transient', UNDETERMINED: 'Undetermined' })
  })
})
