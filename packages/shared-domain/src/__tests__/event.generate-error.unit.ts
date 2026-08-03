import { describe, expect, it, vi } from 'vitest'

import { Event } from '../event.ts'

vi.mock('uuid', () => ({
  v7: () => {
    throw new Error('crypto unavailable')
  }
}))

describe('Event.create', () => {
  it('throws instead of returning an event when id generation fails, since that signals a bug rather than an expected failure', () => {
    expect(() => Event.create('health.degraded', { reason: 'timeout' })).toThrow(
      'Failed to generate an id for event "health.degraded": Failed to generate ID for "Event"'
    )
  })
})
