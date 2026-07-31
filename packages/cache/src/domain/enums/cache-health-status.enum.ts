export const CacheHealthStatus = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy'
} as const

export type CacheHealthStatus = (typeof CacheHealthStatus)[keyof typeof CacheHealthStatus]
