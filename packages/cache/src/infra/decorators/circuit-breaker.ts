export const CircuitBreakerState = {
  CLOSED: 'closed',
  HALF_OPEN: 'half-open',
  OPEN: 'open'
} as const

export type CircuitBreakerState = (typeof CircuitBreakerState)[keyof typeof CircuitBreakerState]

/*
 * Kept apart from the decorator that uses it because it is the only part with a state machine
 * worth testing on its own: the decorator is twenty-two delegations, this is the three
 * transitions that decide whether any of them touch the network.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number
  private readonly resetTimeoutInMs: number

  private consecutiveFailures = 0
  private openedAt = 0
  private probeInFlight = false
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED

  constructor(input: { failureThreshold: number; resetTimeoutInMs: number }) {
    this.failureThreshold = input.failureThreshold
    this.resetTimeoutInMs = input.resetTimeoutInMs
  }

  public currentState(): CircuitBreakerState {
    if (this.state === CircuitBreakerState.OPEN && Date.now() - this.openedAt >= this.resetTimeoutInMs) {
      this.state = CircuitBreakerState.HALF_OPEN
      this.probeInFlight = false
    }

    return this.state
  }

  /*
   * Half-open lets exactly one call through, and `probeInFlight` is what makes that "one" true
   * under concurrency: without it every request that arrived while the window was open would be
   * released at once and hit a cache that is very likely still down.
   */
  public shouldSkip(): boolean {
    const state: CircuitBreakerState = this.currentState()

    if (state === CircuitBreakerState.OPEN) return true
    if (state === CircuitBreakerState.CLOSED) return false
    if (this.probeInFlight) return true

    this.probeInFlight = true

    return false
  }

  public recordSuccess(): void {
    this.consecutiveFailures = 0
    this.probeInFlight = false
    this.state = CircuitBreakerState.CLOSED
  }

  public recordFailure(): void {
    this.consecutiveFailures += 1
    this.probeInFlight = false

    /*
     * A failed probe reopens immediately rather than waiting for the threshold to be met a
     * second time: half-open already established that the cache was down, and the probe is the
     * evidence that it still is.
     */
    if (this.state === CircuitBreakerState.HALF_OPEN || this.consecutiveFailures >= this.failureThreshold) {
      this.state = CircuitBreakerState.OPEN
      this.openedAt = Date.now()
    }
  }
}
