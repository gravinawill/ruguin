import { EmailStatusUpdatedStatus } from '@ruguin/event-schemas'
import { describe, expect, it } from 'vitest'

import { SesNotificationEvent } from '../ses-notification-event.model.ts'

describe('SesNotificationEvent.create', () => {
  it('builds a bounced event carrying the bounceType through', () => {
    const result = SesNotificationEvent.create({
      sesMessageId: 'ses-msg-1',
      eventType: 'Bounce',
      bounceType: 'Transient'
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.sesMessageId).toBe('ses-msg-1')
      expect(result.value.status).toBe(EmailStatusUpdatedStatus.BOUNCED)
      expect(result.value.bounceType).toBe('Transient')
    }
  })

  it('rejects a Bounce with no bounceType', () => {
    const result = SesNotificationEvent.create({ sesMessageId: 'ses-msg-1', eventType: 'Bounce' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.name).toBe('InvalidSesNotificationEventError')
      expect(result.value.message).toBe('bounceType is required when eventType is Bounce')
    }
  })

  it('builds a delivered event with no bounceType', () => {
    const result = SesNotificationEvent.create({ sesMessageId: 'ses-msg-1', eventType: 'Delivery' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.status).toBe(EmailStatusUpdatedStatus.DELIVERED)
      expect(result.value.bounceType).toBeUndefined()
    }
  })

  it('builds a complained event with no bounceType', () => {
    const result = SesNotificationEvent.create({ sesMessageId: 'ses-msg-1', eventType: 'Complaint' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.status).toBe(EmailStatusUpdatedStatus.COMPLAINED)
      expect(result.value.bounceType).toBeUndefined()
    }
  })

  it('rejects a Delivery that carries a bounceType', () => {
    const result = SesNotificationEvent.create({
      sesMessageId: 'ses-msg-1',
      eventType: 'Delivery',
      bounceType: 'Permanent'
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.message).toBe('bounceType is only allowed when eventType is Bounce')
    }
  })

  it('rejects a Complaint that carries a bounceType', () => {
    const result = SesNotificationEvent.create({
      sesMessageId: 'ses-msg-1',
      eventType: 'Complaint',
      bounceType: 'Permanent'
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.message).toBe('bounceType is only allowed when eventType is Bounce')
    }
  })

  it('rejects a sesMessageId that is empty once trimmed', () => {
    const result = SesNotificationEvent.create({ sesMessageId: ' '.repeat(3), eventType: 'Delivery' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.message).toBe('sesMessageId must not be empty')
    }
  })
})
