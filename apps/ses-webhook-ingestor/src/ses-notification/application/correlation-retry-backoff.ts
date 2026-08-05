/*
 * The "not found" race is just Kafka consumer lag (dispatch-worker's sent event usually lands
 * within seconds) — not the multi-minute wait dispatch-worker's own SES-throttling backoff needs,
 * hence the much shorter base and lower ceiling here. Attempt N waits [2^N s, 2^(N+1) s): 2-4s,
 * 4-8s, 8-16s, 16-32s, 32-64s — so 62s..124s in total before the 5-attempt budget is spent.
 */
export const CORRELATION_RETRY_BASE_BACKOFF_MS = 2000
export const CORRELATION_RETRY_MAX_ATTEMPTS = 5

export function computeNextCorrelationRetryAt(attempt: number): Date {
  const ceiling = CORRELATION_RETRY_BASE_BACKOFF_MS * 2 ** attempt
  // eslint-disable-next-line sonarjs/pseudo-random -- Retry-timing jitter, not security-sensitive.
  return new Date(Date.now() + ceiling / 2 + Math.random() * (ceiling / 2))
}

export function hasExhaustedCorrelationRetries(nextAttempt: number): boolean {
  return nextAttempt > CORRELATION_RETRY_MAX_ATTEMPTS
}
