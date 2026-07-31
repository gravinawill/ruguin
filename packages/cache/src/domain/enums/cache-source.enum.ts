export const CacheSource = {
  CACHE: 'cache',
  LOADER: 'loader'
} as const

export type CacheSource = (typeof CacheSource)[keyof typeof CacheSource]
