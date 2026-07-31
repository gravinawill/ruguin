import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CircuitBreaker, CircuitBreakerState } from '../circuit-breaker'

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts closed and lets everything through', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutInMs: 1000 })

    expect(breaker.currentState()).toBe(CircuitBreakerState.CLOSED)
    expect(breaker.shouldSkip()).toBe(false)
  })

  it('opens only after the threshold of consecutive failures', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutInMs: 1000 })

    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.shouldSkip()).toBe(false)

    breaker.recordFailure()
    expect(breaker.currentState()).toBe(CircuitBreakerState.OPEN)
    expect(breaker.shouldSkip()).toBe(true)
  })

  // Consecutive, not cumulative: a cache that answers between blips is a cache that works.
  it('forgets earlier failures once a call succeeds', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutInMs: 1000 })

    breaker.recordFailure()
    breaker.recordFailure()
    breaker.recordSuccess()
    breaker.recordFailure()
    breaker.recordFailure()

    expect(breaker.currentState()).toBe(CircuitBreakerState.CLOSED)
  })

  it('half-opens once the reset window has elapsed', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutInMs: 1000 })
    breaker.recordFailure()

    vi.advanceTimersByTime(999)
    expect(breaker.currentState()).toBe(CircuitBreakerState.OPEN)

    vi.advanceTimersByTime(1)
    expect(breaker.currentState()).toBe(CircuitBreakerState.HALF_OPEN)
  })

  /*
   * Exactly one probe, which is the whole point of half-open: without the in-flight guard every
   * request that queued up during the open window would be released at once, straight into a
   * cache that is very likely still down.
   */
  it('releases exactly one probe while half-open', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutInMs: 1000 })
    breaker.recordFailure()
    vi.advanceTimersByTime(1000)

    expect(breaker.shouldSkip()).toBe(false)
    expect(breaker.shouldSkip()).toBe(true)
    expect(breaker.shouldSkip()).toBe(true)
  })

  it('closes when the probe succeeds', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutInMs: 1000 })
    breaker.recordFailure()
    vi.advanceTimersByTime(1000)
    breaker.shouldSkip()

    breaker.recordSuccess()

    expect(breaker.currentState()).toBe(CircuitBreakerState.CLOSED)
  })

  // Reopens on the first failed probe rather than waiting for the threshold a second time.
  it('reopens when the probe fails, without needing the threshold again', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutInMs: 1000 })
    for (let attempt = 0; attempt < 5; attempt += 1) breaker.recordFailure()
    vi.advanceTimersByTime(1000)
    breaker.shouldSkip()

    breaker.recordFailure()

    expect(breaker.currentState()).toBe(CircuitBreakerState.OPEN)
  })
})
