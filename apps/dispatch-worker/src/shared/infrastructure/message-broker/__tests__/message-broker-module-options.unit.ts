import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('createMessageBrokerModuleOptions', () => {
  beforeEach(() => {
    vi.stubEnv('KAFKA_CLIENT_ID', 'ruguin')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('trims whitespace and drops blank entries from KAFKA_BOOTSTRAP_BROKERS', async () => {
    vi.stubEnv('KAFKA_BOOTSTRAP_BROKERS', 'broker-a:9092, broker-b:9092,')

    const { createMessageBrokerModuleOptions } = await import('../message-broker-module-options.ts')

    expect(createMessageBrokerModuleOptions().brokers).toEqual(['broker-a:9092', 'broker-b:9092'])
  })

  it('throws when KAFKA_BOOTSTRAP_BROKERS normalizes to an empty broker list', async () => {
    vi.stubEnv('KAFKA_BOOTSTRAP_BROKERS', ' , ,')

    const { createMessageBrokerModuleOptions } = await import('../message-broker-module-options.ts')

    expect(() => createMessageBrokerModuleOptions()).toThrow(/at least one non-empty broker/)
  })
})
