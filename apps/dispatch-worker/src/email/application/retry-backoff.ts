const BASE_BACKOFF_MS = 5000

export const MAX_RETRY_ATTEMPTS = 3

export function computeNextRetryAt(attempt: number): Date {
  return new Date(Date.now() + BASE_BACKOFF_MS * 2 ** attempt)
}

export function hasExhaustedRetries(nextAttempt: number): boolean {
  return nextAttempt > MAX_RETRY_ATTEMPTS
}
