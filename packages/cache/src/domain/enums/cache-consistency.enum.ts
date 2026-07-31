export const CacheConsistency = {
  EVENTUAL: 'eventual',
  STRONG: 'strong'
} as const

export type CacheConsistency = (typeof CacheConsistency)[keyof typeof CacheConsistency]
