import { afterEach, describe, expect, it, vi } from 'vitest'

const setEnvironment = (environment: Record<string, string>): void => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
}

const MINIMUM_REQUIRED_ENVIRONMENT = {
  ENVIRONMENT: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/ruguin?schema=core_server',
  CACHE_PREFIX: 'ruguin:core-server',
  KAFKA_BOOTSTRAP_BROKERS: 'localhost:9092',
  DOCS_USERNAME: 'admin',
  DOCS_PASSWORD: 'super-secret'
}

describe('coreServerENV', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('exposes every field from each extended package', async () => {
    setEnvironment(MINIMUM_REQUIRED_ENVIRONMENT)

    const { coreServerENV } = await import('../core-server.environment.ts')

    // serverENV
    expect(coreServerENV.ENVIRONMENT).toBe('test')
    expect(coreServerENV.PORT).toBe(3333)
    // databaseENV
    expect(coreServerENV.DATABASE_URL).toBe(MINIMUM_REQUIRED_ENVIRONMENT.DATABASE_URL)
    // cacheENV
    expect(coreServerENV.CACHE_PREFIX).toBe('ruguin:core-server')
    expect(coreServerENV.CACHE_DRIVER).toBe('memory')
    // messageBrokerENV
    expect(coreServerENV.KAFKA_BOOTSTRAP_BROKERS).toBe('localhost:9092')
    // docsENV
    expect(coreServerENV.DOCS_USERNAME).toBe('admin')
    expect(coreServerENV.DOCS_PASSWORD).toBe('super-secret')
  })

  it('throws when a required field from any extended package is missing', async () => {
    setEnvironment({ ...MINIMUM_REQUIRED_ENVIRONMENT, DATABASE_URL: '' })

    const { coreServerENV } = await import('../core-server.environment.ts')

    expect(() => ({ ...coreServerENV })).toThrow()
  })
})
