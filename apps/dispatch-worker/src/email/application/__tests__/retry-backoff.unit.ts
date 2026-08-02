import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { computeNextRetryAt, hasExhaustedRetries, MAX_RETRY_ATTEMPTS } from '../retry-backoff.ts'

describe('retry-backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('computes ~10s / ~20s / ~40s for attempts 1, 2, 3', () => {
    expect(computeNextRetryAt(1)).toEqual(new Date('2026-08-02T12:00:10.000Z'))
    expect(computeNextRetryAt(2)).toEqual(new Date('2026-08-02T12:00:20.000Z'))
    expect(computeNextRetryAt(3)).toEqual(new Date('2026-08-02T12:00:40.000Z'))
  })

  it('exposes 3 as the max retry attempts', () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(3)
  })

  it('has not exhausted retries for attempt 1, 2, or 3', () => {
    expect(hasExhaustedRetries(1)).toBe(false)
    expect(hasExhaustedRetries(2)).toBe(false)
    expect(hasExhaustedRetries(3)).toBe(false)
  })

  it('has exhausted retries once the next attempt would be 4', () => {
    expect(hasExhaustedRetries(4)).toBe(true)
  })
})
