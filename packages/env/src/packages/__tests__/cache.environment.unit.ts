import { afterEach, describe, expect, it, vi } from 'vitest'

const setEnvironment = (environment: Record<string, string>) => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
}

describe('cacheENV', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('parses the prefix and applies the defaults', async () => {
    setEnvironment({
      CACHE_PREFIX: 'ruguin:ledger',
      CACHE_DRIVER: '',
      CACHE_DEFAULT_TTL_MS: '',
      CACHE_JITTER_RATIO: '',
      CACHE_NEGATIVE_TTL_MS: '',
      CACHE_NS_VERSION_LOCAL_TTL_MS: ''
    })

    const { cacheENV } = await import('../cache.environment')

    expect(cacheENV.CACHE_PREFIX).toBe('ruguin:ledger')
    expect(cacheENV.CACHE_DRIVER).toBe('memory')
    expect(cacheENV.CACHE_DEFAULT_TTL_MS).toBe(300_000)
    // eslint-disable-next-line sonarjs/no-floating-point-equality -- no arithmetic happens: the schema's default and this literal are the same source token, so they are the same double. A range would let a wrong default pass.
    expect(cacheENV.CACHE_JITTER_RATIO).toBe(0.1)
    expect(cacheENV.CACHE_NEGATIVE_TTL_MS).toBe(30_000)
    expect(cacheENV.CACHE_NS_VERSION_LOCAL_TTL_MS).toBe(5000)
  })

  it('coerces numeric env vars from strings', async () => {
    setEnvironment({
      CACHE_PREFIX: 'ruguin:iam',
      CACHE_DEFAULT_TTL_MS: '60000',
      CACHE_JITTER_RATIO: '0.25',
      CACHE_NEGATIVE_TTL_MS: '5000',
      CACHE_NS_VERSION_LOCAL_TTL_MS: '0'
    })

    const { cacheENV } = await import('../cache.environment')

    expect(cacheENV.CACHE_DEFAULT_TTL_MS).toBe(60_000)

    expect(cacheENV.CACHE_JITTER_RATIO).toBe(0.25)
    expect(cacheENV.CACHE_NEGATIVE_TTL_MS).toBe(5000)
    expect(cacheENV.CACHE_NS_VERSION_LOCAL_TTL_MS).toBe(0)
  })

  it('accepts the noop driver, which is how caching gets switched off', async () => {
    setEnvironment({ CACHE_PREFIX: 'ruguin:ledger', CACHE_DRIVER: 'noop' })

    const { cacheENV } = await import('../cache.environment')

    expect(cacheENV.CACHE_DRIVER).toBe('noop')
  })

  it('rejects an unknown driver instead of silently falling back', async () => {
    setEnvironment({ CACHE_PREFIX: 'ruguin:ledger', CACHE_DRIVER: 'valkey' })

    await expect(import('../cache.environment')).rejects.toThrow()
  })

  it('throws when the required prefix is missing', async () => {
    setEnvironment({ CACHE_PREFIX: '' })

    await expect(import('../cache.environment')).rejects.toThrow()
  })

  it('rejects a jitter ratio outside 0..1', async () => {
    setEnvironment({ CACHE_PREFIX: 'ruguin:ledger', CACHE_JITTER_RATIO: '1.5' })

    await expect(import('../cache.environment')).rejects.toThrow()
  })
})
