import { afterEach, describe, expect, it, vi } from 'vitest'

const setEnvironment = (environment: Record<string, string>): void => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
}

const MINIMUM_REQUIRED_ENVIRONMENT = {
  ENVIRONMENT: 'test',
  CACHE_PREFIX: 'ruguin:dispatch-worker',
  KAFKA_BOOTSTRAP_BROKERS: 'localhost:9092',
  SES_FROM_ADDRESS: 'sender@ruguin.dev'
}

describe('dispatchWorkerENV', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('exposes every field from each extended package', async () => {
    setEnvironment(MINIMUM_REQUIRED_ENVIRONMENT)

    const { dispatchWorkerENV } = await import('../dispatch-worker.environment.ts')

    // serverENV
    expect(dispatchWorkerENV.ENVIRONMENT).toBe('test')
    // cacheENV
    expect(dispatchWorkerENV.CACHE_PREFIX).toBe('ruguin:dispatch-worker')
    expect(dispatchWorkerENV.CACHE_DRIVER).toBe('memory')
    // messageBrokerENV
    expect(dispatchWorkerENV.KAFKA_BOOTSTRAP_BROKERS).toBe('localhost:9092')
    // awsENV
    expect(dispatchWorkerENV.SES_FROM_ADDRESS).toBe('sender@ruguin.dev')
    expect(dispatchWorkerENV.AWS_REGION).toBe('us-east-1')
    expect(dispatchWorkerENV.AWS_ACCESS_KEY_ID).toBeUndefined()
  })

  it('throws when a required field from any extended package is missing', async () => {
    setEnvironment({ ...MINIMUM_REQUIRED_ENVIRONMENT, SES_FROM_ADDRESS: '' })

    const { dispatchWorkerENV } = await import('../dispatch-worker.environment.ts')

    expect(() => ({ ...dispatchWorkerENV })).toThrow()
  })
})
