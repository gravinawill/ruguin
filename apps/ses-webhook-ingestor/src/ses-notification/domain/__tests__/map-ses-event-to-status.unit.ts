import { EmailStatusUpdatedStatus } from '@ruguin/event-schemas'
import { describe, expect, it } from 'vitest'

import { mapSesEventToStatus } from '../map-ses-event-to-status.ts'

describe('mapSesEventToStatus', () => {
  it('maps Delivery to delivered, with no bounceType', () => {
    const result = mapSesEventToStatus({ eventType: 'Delivery', mail: { messageId: 'ses-msg-1' } })

    expect(result).toEqual({ status: EmailStatusUpdatedStatus.DELIVERED })
  })

  it('maps Complaint to complained, with no bounceType', () => {
    const result = mapSesEventToStatus({ eventType: 'Complaint', mail: { messageId: 'ses-msg-1' } })

    expect(result).toEqual({ status: EmailStatusUpdatedStatus.COMPLAINED })
  })

  it('maps Bounce to bounced, carrying bounceType through', () => {
    const result = mapSesEventToStatus({
      eventType: 'Bounce',
      mail: { messageId: 'ses-msg-1' },
      bounce: { bounceType: 'Transient' }
    })

    expect(result).toEqual({ status: EmailStatusUpdatedStatus.BOUNCED, bounceType: 'Transient' })
  })
})
