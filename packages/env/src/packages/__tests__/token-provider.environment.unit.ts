import { afterEach, describe, expect, it, vi } from 'vitest'

const setEnvironment = (environment: Record<string, string>) => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
}

describe('tokenProviderENV', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('parses both secrets and applies the confirmed defaults (5 min / 30 days)', async () => {
    setEnvironment({
      JWT_ACCESS_TOKEN_SECRET: 'super-secret-access',
      JWT_REFRESH_TOKEN_SECRET: 'super-secret-refresh',
      JWT_ACCESS_TOKEN_EXPIRES_IN: '',
      JWT_REFRESH_TOKEN_EXPIRES_IN: '',
      JWT_ACCESS_TOKEN_EXPIRES_UNIT: '',
      JWT_REFRESH_TOKEN_EXPIRES_UNIT: '',
      JWT_ISSUER: '',
      JWT_AUDIENCE: '',
      JWT_ALGORITHM: ''
    })

    const { tokenProviderENV } = await import('../token-provider.environment')

    expect(tokenProviderENV.JWT_ACCESS_TOKEN_SECRET).toBe('super-secret-access')
    expect(tokenProviderENV.JWT_REFRESH_TOKEN_SECRET).toBe('super-secret-refresh')
    expect(tokenProviderENV.JWT_ACCESS_TOKEN_EXPIRES_IN).toBe(5)
    expect(tokenProviderENV.JWT_ACCESS_TOKEN_EXPIRES_UNIT).toBe('minutes')
    expect(tokenProviderENV.JWT_REFRESH_TOKEN_EXPIRES_IN).toBe(30)
    expect(tokenProviderENV.JWT_REFRESH_TOKEN_EXPIRES_UNIT).toBe('days')
    expect(tokenProviderENV.JWT_ISSUER).toBe('ruguin-iam')
    expect(tokenProviderENV.JWT_AUDIENCE).toBe('ruguin-clients')
    expect(tokenProviderENV.JWT_ALGORITHM).toBe('HS256')
  })

  it('coerces numeric env vars from strings', async () => {
    setEnvironment({
      JWT_ACCESS_TOKEN_SECRET: 'super-secret-access',
      JWT_REFRESH_TOKEN_SECRET: 'super-secret-refresh',
      JWT_ACCESS_TOKEN_EXPIRES_IN: '15',
      JWT_REFRESH_TOKEN_EXPIRES_IN: '14'
    })

    const { tokenProviderENV } = await import('../token-provider.environment')

    expect(tokenProviderENV.JWT_ACCESS_TOKEN_EXPIRES_IN).toBe(15)
    expect(tokenProviderENV.JWT_REFRESH_TOKEN_EXPIRES_IN).toBe(14)
  })

  it('throws when the required access token secret is missing', async () => {
    setEnvironment({
      JWT_ACCESS_TOKEN_SECRET: '',
      JWT_REFRESH_TOKEN_SECRET: 'super-secret-refresh'
    })

    await expect(import('../token-provider.environment')).rejects.toThrow()
  })

  it('throws when the required refresh token secret is missing', async () => {
    setEnvironment({
      JWT_ACCESS_TOKEN_SECRET: 'super-secret-access',
      JWT_REFRESH_TOKEN_SECRET: ''
    })

    await expect(import('../token-provider.environment')).rejects.toThrow()
  })
})
