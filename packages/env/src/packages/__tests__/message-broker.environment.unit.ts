import { afterEach, describe, expect, it, vi } from 'vitest'

const setEnvironment = (environment: Record<string, string>) => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
}

describe('messageBrokerENV', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('parses brokers and applies defaults', async () => {
    setEnvironment({
      KAFKA_BOOTSTRAP_BROKERS: 'localhost:9092',
      KAFKA_CLIENT_ID: '',
      KAFKA_SSL: '',
      KAFKA_AUTO_CREATE_TOPICS: '',
      KAFKA_TOPIC_PARTITIONS: '',
      KAFKA_TOPIC_REPLICATION_FACTOR: ''
    })

    const { messageBrokerENV } = await import('../message-broker.environment')

    expect(messageBrokerENV.KAFKA_BOOTSTRAP_BROKERS).toBe('localhost:9092')
    expect(messageBrokerENV.KAFKA_CLIENT_ID).toBe('ruguin')
    expect(messageBrokerENV.KAFKA_SSL).toBe(false)
    expect(messageBrokerENV.KAFKA_AUTO_CREATE_TOPICS).toBe(false)
    expect(messageBrokerENV.KAFKA_TOPIC_PARTITIONS).toBe(3)
    expect(messageBrokerENV.KAFKA_TOPIC_REPLICATION_FACTOR).toBe(1)
  })

  it('coerces booleans and numbers from strings', async () => {
    setEnvironment({
      KAFKA_BOOTSTRAP_BROKERS: 'h1:9092,h2:9092',
      KAFKA_AUTO_CREATE_TOPICS: 'true',
      KAFKA_TOPIC_PARTITIONS: '6'
    })

    const { messageBrokerENV } = await import('../message-broker.environment')

    expect(messageBrokerENV.KAFKA_AUTO_CREATE_TOPICS).toBe(true)
    expect(messageBrokerENV.KAFKA_TOPIC_PARTITIONS).toBe(6)
  })

  it('throws when the required brokers var is missing', async () => {
    setEnvironment({ KAFKA_BOOTSTRAP_BROKERS: '' })
    const { messageBrokerENV } = await import('../message-broker.environment')

    expect(() => ({ ...messageBrokerENV })).toThrow()
  })

  it('parses the literal string "false" to boolean false (guards against z.coerce.boolean regression)', async () => {
    setEnvironment({
      KAFKA_BOOTSTRAP_BROKERS: 'localhost:9092',
      KAFKA_SSL: 'false',
      KAFKA_AUTO_CREATE_TOPICS: 'false'
    })

    const { messageBrokerENV } = await import('../message-broker.environment')

    expect(messageBrokerENV.KAFKA_SSL).toBe(false)
    expect(messageBrokerENV.KAFKA_AUTO_CREATE_TOPICS).toBe(false)
  })
})
