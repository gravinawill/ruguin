import { afterEach, describe, expect, it, vi } from 'vitest'

const setEnvironment = (environment: Record<string, string>): void => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
}

describe('docsENV', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('parses the configured username and password', async () => {
    setEnvironment({ DOCS_USERNAME: 'admin', DOCS_PASSWORD: 'super-secret' })

    const { docsENV } = await import('../docs.environment')

    expect(docsENV.DOCS_USERNAME).toBe('admin')
    expect(docsENV.DOCS_PASSWORD).toBe('super-secret')
  })

  it('throws when DOCS_USERNAME is missing', async () => {
    setEnvironment({ DOCS_USERNAME: '', DOCS_PASSWORD: 'super-secret' })

    const { docsENV } = await import('../docs.environment')

    expect(() => ({ ...docsENV })).toThrow()
  })

  it('throws when DOCS_PASSWORD is missing', async () => {
    setEnvironment({ DOCS_USERNAME: 'admin', DOCS_PASSWORD: '' })

    const { docsENV } = await import('../docs.environment')

    expect(() => ({ ...docsENV })).toThrow()
  })
})
