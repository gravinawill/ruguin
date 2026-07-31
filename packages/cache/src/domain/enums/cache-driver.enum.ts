export const CacheDriver = {
  VALKEY: 'valkey',
  MEMORY: 'memory',
  NOOP: 'noop'
} as const

export type CacheDriver = (typeof CacheDriver)[keyof typeof CacheDriver]
