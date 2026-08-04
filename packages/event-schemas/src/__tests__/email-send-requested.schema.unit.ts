import { describe, expect, it } from 'vitest'

import {
  EMAIL_SEND_REQUESTED_DLQ_TOPIC,
  EMAIL_SEND_REQUESTED_RETRY_TOPIC,
  EMAIL_SEND_REQUESTED_TOPIC,
  EmailSendRequestedPayloadSchema
} from '../email-send-requested.schema.ts'
import { createMessageEnvelopeSchema } from '../message-envelope.schema.ts'

describe('EmailSendRequestedPayloadSchema', () => {
  const validPayload = {
    emailId: '018f9a9e-6f0a-7c3e-9b0a-000000000001',
    organizationId: '018f9a9e-6f0a-7c3e-9b0a-000000000002',
    projectId: '018f9a9e-6f0a-7c3e-9b0a-000000000003',
    from: 'sender@ruguin.dev',
    to: 'recipient@ruguin.dev',
    subject: 'Welcome',
    html: '<p>Hi</p>'
  }

  it('accepts a valid payload', () => {
    const result = EmailSendRequestedPayloadSchema.safeParse(validPayload)

    expect(result.success).toBe(true)
  })

  it('accepts a valid payload with an optional idempotencyKey', () => {
    const result = EmailSendRequestedPayloadSchema.safeParse({ ...validPayload, idempotencyKey: 'idem-1' })

    expect(result.success).toBe(true)
  })

  it('rejects a payload missing a required field', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars,sonarjs/no-unused-vars -- intentionally destructure subject to test exclusion
    const { subject: _subject, ...withoutSubject } = validPayload

    const result = EmailSendRequestedPayloadSchema.safeParse(withoutSubject)

    expect(result.success).toBe(false)
  })

  it('rejects an invalid "from" email address', () => {
    const result = EmailSendRequestedPayloadSchema.safeParse({ ...validPayload, from: 'not-an-email' })

    expect(result.success).toBe(false)
  })

  it('validates against the generic envelope', () => {
    const envelopeSchema = createMessageEnvelopeSchema(EmailSendRequestedPayloadSchema)

    const result = envelopeSchema.safeParse({
      eventId: '018f9a9e-6f0a-7c3e-9b0a-000000000004',
      name: 'email.send.requested',
      payload: validPayload
    })

    expect(result.success).toBe(true)
  })
})

describe('email.send.requested topic names', () => {
  it('exposes main, retry, and DLQ topic constants', () => {
    expect(EMAIL_SEND_REQUESTED_TOPIC).toBe('email.send.requested')
    expect(EMAIL_SEND_REQUESTED_RETRY_TOPIC).toBe('email.send.requested.retry')
    expect(EMAIL_SEND_REQUESTED_DLQ_TOPIC).toBe('email.send.requested.dlq')
  })
})
