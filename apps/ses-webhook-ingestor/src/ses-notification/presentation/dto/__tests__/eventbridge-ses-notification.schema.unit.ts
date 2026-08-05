import { describe, expect, it } from 'vitest'

import { EventBridgeSesNotificationSchema } from '../eventbridge-ses-notification.schema.ts'

describe('EventBridgeSesNotificationSchema', () => {
  it('accepts a Delivery notification', () => {
    const result = EventBridgeSesNotificationSchema.safeParse({
      id: 'evt-1',
      source: 'aws.ses',
      detail: { eventType: 'Delivery', mail: { messageId: 'ses-msg-1' } }
    })

    expect(result.success).toBe(true)
  })

  it('accepts a Bounce notification with bounceType', () => {
    const result = EventBridgeSesNotificationSchema.safeParse({
      id: 'evt-2',
      source: 'aws.ses',
      detail: { eventType: 'Bounce', mail: { messageId: 'ses-msg-2' }, bounce: { bounceType: 'Permanent' } }
    })

    expect(result.success).toBe(true)
  })

  it('rejects a Bounce notification missing the bounce object', () => {
    const result = EventBridgeSesNotificationSchema.safeParse({
      id: 'evt-3',
      source: 'aws.ses',
      detail: { eventType: 'Bounce', mail: { messageId: 'ses-msg-3' } }
    })

    expect(result.success).toBe(false)
  })

  it('rejects a source other than aws.ses', () => {
    const result = EventBridgeSesNotificationSchema.safeParse({
      id: 'evt-4',
      source: 'aws.sns',
      detail: { eventType: 'Delivery', mail: { messageId: 'ses-msg-4' } }
    })

    expect(result.success).toBe(false)
  })

  it('rejects an eventType outside Delivery/Bounce/Complaint', () => {
    const result = EventBridgeSesNotificationSchema.safeParse({
      id: 'evt-5',
      source: 'aws.ses',
      detail: { eventType: 'Send', mail: { messageId: 'ses-msg-5' } }
    })

    expect(result.success).toBe(false)
  })
})
