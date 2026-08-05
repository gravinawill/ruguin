import { afterEach, describe, expect, it, vi } from 'vitest'

const setEnvironment = (environment: Record<string, string>): void => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
}

const MINIMUM_REQUIRED_ENVIRONMENT = {
  ENVIRONMENT: 'test',
  CACHE_PREFIX: 'ruguin:ses-webhook-ingestor',
  KAFKA_BOOTSTRAP_BROKERS: 'localhost:9092',
  DATABASE_URL: 'postgresql://ruguin:ruguin@localhost:5432/ruguin',
  SES_WEBHOOK_INGESTOR_SHARED_SECRET: 'a-shared-secret-that-is-at-least-32-chars-long'
}

describe('sesWebhookIngestorENV', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('exposes every field from each extended package plus its own', async () => {
    setEnvironment(MINIMUM_REQUIRED_ENVIRONMENT)

    const { sesWebhookIngestorENV } = await import('../ses-webhook-ingestor.environment.ts')

    // serverENV
    expect(sesWebhookIngestorENV.ENVIRONMENT).toBe('test')
    // cacheENV
    expect(sesWebhookIngestorENV.CACHE_PREFIX).toBe('ruguin:ses-webhook-ingestor')
    // messageBrokerENV
    expect(sesWebhookIngestorENV.KAFKA_BOOTSTRAP_BROKERS).toBe('localhost:9092')
    // databaseENV
    expect(sesWebhookIngestorENV.DATABASE_URL).toBe('postgresql://ruguin:ruguin@localhost:5432/ruguin')
    // its own field
    expect(sesWebhookIngestorENV.SES_WEBHOOK_INGESTOR_SHARED_SECRET).toBe(
      'a-shared-secret-that-is-at-least-32-chars-long'
    )
  })

  it('throws when SES_WEBHOOK_INGESTOR_SHARED_SECRET is missing', async () => {
    setEnvironment({ ...MINIMUM_REQUIRED_ENVIRONMENT, SES_WEBHOOK_INGESTOR_SHARED_SECRET: '' })

    const { sesWebhookIngestorENV } = await import('../ses-webhook-ingestor.environment.ts')

    expect(() => ({ ...sesWebhookIngestorENV })).toThrow()
  })

  it('throws when SES_WEBHOOK_INGESTOR_SHARED_SECRET is shorter than 32 characters', async () => {
    setEnvironment({ ...MINIMUM_REQUIRED_ENVIRONMENT, SES_WEBHOOK_INGESTOR_SHARED_SECRET: 'too-short-secret' })

    const { sesWebhookIngestorENV } = await import('../ses-webhook-ingestor.environment.ts')

    expect(() => ({ ...sesWebhookIngestorENV })).toThrow()
  })

  it('throws when a required field from an extended package is missing', async () => {
    setEnvironment({ ...MINIMUM_REQUIRED_ENVIRONMENT, DATABASE_URL: '' })

    const { sesWebhookIngestorENV } = await import('../ses-webhook-ingestor.environment.ts')

    expect(() => ({ ...sesWebhookIngestorENV })).toThrow()
  })
})
