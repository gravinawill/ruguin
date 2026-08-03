import { afterEach, describe, expect, it, vi } from 'vitest'

const setEnvironment = (environment: Record<string, string>): void => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
}

describe('createPinoHttpOptions', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('defaults to debug level and pretty-prints outside production', async () => {
    setEnvironment({ ENVIRONMENT: 'develop' })
    const { createPinoHttpOptions } = await import('../pino-http-options.ts')

    const options = createPinoHttpOptions()

    expect(options.level).toBe('debug')
    expect(options.transport).toEqual({ target: 'pino-pretty' })
  })

  it('raises the level to info and disables pretty-print in production', async () => {
    setEnvironment({ ENVIRONMENT: 'production' })
    const { createPinoHttpOptions } = await import('../pino-http-options.ts')

    const options = createPinoHttpOptions()

    expect(options.level).toBe('info')
    expect(options.transport).toBeUndefined()
  })
})
