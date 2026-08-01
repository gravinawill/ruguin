import { describe, expect, it } from 'vitest'

import { applyTtlJitter } from '../apply-ttl-jitter.ts'

describe('applyTtlJitter', () => {
  it('falls back to the configured default when the caller gives no ttl', () => {
    expect(applyTtlJitter({ applyJitter: false, defaultTtlInMs: 300_000, jitterRatio: 0.1, ttlInMs: undefined })).toBe(
      300_000
    )
  })

  it('returns the ttl untouched when jitter is switched off for the call', () => {
    expect(applyTtlJitter({ applyJitter: false, defaultTtlInMs: 1000, jitterRatio: 0.5, ttlInMs: 5000 })).toBe(5000)
  })

  it('returns the ttl untouched when the ratio is zero', () => {
    expect(applyTtlJitter({ applyJitter: undefined, defaultTtlInMs: 1000, jitterRatio: 0, ttlInMs: 5000 })).toBe(5000)
  })

  /*
   * The spread is what keeps a thousand keys written by one deploy from expiring in the same
   * millisecond and bringing the stampede back in waves.
   */
  it('stays inside the ratio band when jitter is on', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ttl: number = applyTtlJitter({
        applyJitter: undefined,
        defaultTtlInMs: 1000,
        jitterRatio: 0.1,
        ttlInMs: 10_000
      })

      expect(ttl).toBeGreaterThanOrEqual(9000)
      expect(ttl).toBeLessThanOrEqual(11_000)
    }
  })

  it('never produces a non-positive ttl, which Valkey would reject', () => {
    expect(applyTtlJitter({ applyJitter: undefined, defaultTtlInMs: 1, jitterRatio: 1, ttlInMs: 1 })).toBeGreaterThan(0)
  })
})
