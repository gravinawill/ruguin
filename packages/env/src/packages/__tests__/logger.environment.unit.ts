import { afterEach, describe, expect, it, vi } from 'vitest'

const setEnvironment = (environment: Record<string, string>): void => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
}

describe('loggerENV', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('applies the defaults (pino / pretty) when unset', async () => {
    setEnvironment({ LOGGER_DRIVER: '', LOG_FORMAT: '' })

    const { loggerENV } = await import('../logger.environment')

    expect(loggerENV.LOGGER_DRIVER).toBe('pino')
    expect(loggerENV.LOG_FORMAT).toBe('pretty')
  })

  it('parses winston / json', async () => {
    setEnvironment({ LOGGER_DRIVER: 'winston', LOG_FORMAT: 'json' })

    const { loggerENV } = await import('../logger.environment')

    expect(loggerENV.LOGGER_DRIVER).toBe('winston')
    expect(loggerENV.LOG_FORMAT).toBe('json')
  })

  it('rejects an invalid driver', async () => {
    setEnvironment({ LOGGER_DRIVER: 'bunyan' })

    await expect(import('../logger.environment')).rejects.toThrow()
  })
})
