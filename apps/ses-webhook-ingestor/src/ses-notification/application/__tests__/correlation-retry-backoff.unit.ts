import { describe, expect, it } from 'vitest'

import {
  computeNextCorrelationRetryAt,
  CORRELATION_RETRY_MAX_ATTEMPTS,
  hasExhaustedCorrelationRetries
} from '../correlation-retry-backoff.ts'

describe('correlation-retry-backoff', () => {
  it('computeNextCorrelationRetryAt returns a Date strictly in the future', () => {
    const now = Date.now()

    expect(computeNextCorrelationRetryAt(1).getTime()).toBeGreaterThan(now)
  })

  it('hasExhaustedCorrelationRetries is false at exactly the max attempts', () => {
    expect(hasExhaustedCorrelationRetries(CORRELATION_RETRY_MAX_ATTEMPTS)).toBe(false)
  })

  it('hasExhaustedCorrelationRetries is true one past the max attempts', () => {
    expect(hasExhaustedCorrelationRetries(CORRELATION_RETRY_MAX_ATTEMPTS + 1)).toBe(true)
  })
})
