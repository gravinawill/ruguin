import { describe, expect, it } from 'vitest'

import { Event } from '../event.ts'
import { ID } from '../value-objects/index.ts'

type SamplePayload = { reason: string }

describe('Event.create', () => {
  it('produces an event with a generated id, the given name and payload', () => {
    const event = Event.create<SamplePayload>('health.degraded', { reason: 'timeout' })

    expect(event.name).toBe('health.degraded')
    expect(event.payload).toEqual({ reason: 'timeout' })
    expect(event.id).toBeInstanceOf(ID)
  })

  it('stamps occurredAt with the creation time', () => {
    const before = new Date()
    const event = Event.create<SamplePayload>('health.degraded', { reason: 'timeout' })
    const after = new Date()

    expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(event.occurredAt.getTime()).toBeLessThanOrEqual(after.getTime())
  })

  it('generates a distinct id for every call, even with identical name and payload', () => {
    const first = Event.create<SamplePayload>('health.degraded', { reason: 'timeout' })
    const second = Event.create<SamplePayload>('health.degraded', { reason: 'timeout' })

    expect(first.id.equals({ otherID: second.id })).toBe(false)
  })

  it('produces an id that satisfies ID.validate', () => {
    const event = Event.create<SamplePayload>('health.degraded', { reason: 'timeout' })

    const validated = ID.validate({ id: event.id.toString(), valueObjectName: 'Event' })

    expect(validated.isSuccess()).toBe(true)
  })

  it('does not let a caller mutate occurredAt through the returned Date', () => {
    const event = Event.create<SamplePayload>('health.degraded', { reason: 'timeout' })
    const originalTime = event.occurredAt.getTime()

    event.occurredAt.setTime(0)

    expect(event.occurredAt.getTime()).toBe(originalTime)
  })

  it('freezes the payload so a caller cannot mutate it after creation', () => {
    const event = Event.create<SamplePayload>('health.degraded', { reason: 'timeout' })

    /*
     * `readonly` on Event#payload only guards reassigning the field itself; this asserts the
     * runtime guard (Object.freeze) that stops mutating the payload object's own properties too.
     */
    expect(() => {
      event.payload.reason = 'mutated'
    }).toThrow()
    expect(event.payload).toEqual({ reason: 'timeout' })
  })

  it('freezes nested objects and arrays inside the payload', () => {
    type NestedPayload = { tags: string[]; detail: { code: number } }
    const event = Event.create<NestedPayload>('health.degraded', { detail: { code: 503 }, tags: ['a', 'b'] })

    expect(Object.isFrozen(event.payload.tags)).toBe(true)
    expect(Object.isFrozen(event.payload.detail)).toBe(true)
  })
})
