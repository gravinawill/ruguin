/*
 * What happened to getOrSet's fill lock. Three states rather than a boolean, because
 * `lockAcquired: false` would collapse two situations a caller has to act on differently:
 * a call where no lock was ever attempted (normal) and a call that asked for one and did not
 * get it (degraded — the loader ran with no stampede protection). Anything counting failures
 * off a boolean would fire on every ordinary unlocked read.
 *
 * A string union rather than `boolean | null` for the same reason: `if (!lockAcquired)` is the
 * mistake the third state exists to prevent, and every member here is truthy, so the compare
 * has to be written out.
 *
 * NOT_ATTEMPTED, not NOT_REQUESTED: it also covers a caller who did ask for the lock but was
 * served from cache before the lock logic ran. Both are the non-degraded case, and `source`
 * already says which one it was.
 */
export const CacheLockOutcome = {
  NOT_ATTEMPTED: 'not-attempted',
  ACQUIRED: 'acquired',
  NOT_ACQUIRED: 'not-acquired'
} as const

export type CacheLockOutcome = (typeof CacheLockOutcome)[keyof typeof CacheLockOutcome]
