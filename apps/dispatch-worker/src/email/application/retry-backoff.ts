export const BASE_BACKOFF_MS = 5000

export const MAX_RETRY_ATTEMPTS = 3

/*
 * Half jitter: every delay lands in [ceiling/2, ceiling], never above the deterministic ceiling
 * (so callers computing a worst-case timeout from BASE_BACKOFF_MS/MAX_RETRY_ATTEMPTS stay safe)
 * but spread out enough that a burst of messages rate-limited in the same window don't all wake
 * up and hit the same SES rate-limiter key at once.
 */
export function computeNextRetryAt(attempt: number): Date {
  const ceiling = BASE_BACKOFF_MS * 2 ** attempt
  // eslint-disable-next-line sonarjs/pseudo-random -- Retry-timing jitter, not security-sensitive; Math.random() is fine here.
  return new Date(Date.now() + ceiling / 2 + Math.random() * (ceiling / 2))
}

export function hasExhaustedRetries(nextAttempt: number): boolean {
  return nextAttempt > MAX_RETRY_ATTEMPTS
}
