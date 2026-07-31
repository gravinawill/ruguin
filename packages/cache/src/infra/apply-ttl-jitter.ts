/*
 * Spreads expiries so a batch of keys written together does not all die in the same
 * millisecond. Shared by every driver: the drivers differ in where the bytes land, not in how
 * a TTL is chosen, and two copies of this would drift the moment one of them is tuned.
 */
export const applyTtlJitter = (input: {
  applyJitter: boolean | undefined
  defaultTtlInMs: number
  jitterRatio: number
  ttlInMs: number | undefined
}): number => {
  const base: number = input.ttlInMs ?? input.defaultTtlInMs
  if (input.applyJitter === false || input.jitterRatio === 0) return base

  const spread: number = base * input.jitterRatio

  // eslint-disable-next-line sonarjs/pseudo-random -- TTL jitter is a load-spreading heuristic, not a security primitive
  return Math.max(1, Math.round(base - spread + Math.random() * spread * 2))
}
